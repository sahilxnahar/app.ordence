-- =====================================================================
-- ORDENCE · 0042 — MCP ACCESS (delivered to the operator as 29.sql)
-- =====================================================================
-- Creates the tables that let an AI assistant operate a tenant's Ordence
-- workspace through the Model Context Protocol, WITHOUT ever holding a
-- user's password, a Clerk session, or a database credential.
--
-- ⚠️ WHY A TOKEN TABLE AND NOT "JUST USE THE CLERK SESSION"
--
-- An MCP client is not a browser. It has no cookie jar, it is not
-- redirected through a sign-in page, and it frequently runs on a machine
-- the tenant does not own. Reusing the browser session would mean either
-- (a) copying a session cookie into a config file — a credential with
-- full UI powers, no scope, and no revocation — or (b) exempting MCP
-- from `middleware.ts`, which is the one thing that must never happen.
--
-- So MCP gets its own credential type: scoped, revocable, per-tenant,
-- hashed at rest, and independently rate-limited.
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 THE TOKEN IS STORED AS A SHA-256 HASH, NEVER IN PLAINTEXT
-- ══════════════════════════════════════════════════════════════════════
-- `token_hash` holds the digest. The token itself is shown ONCE, at
-- creation, and never again — the same discipline as an R2 Account API
-- token. A database dump therefore leaks nothing usable.
--
-- This project has already lost credentials twice by writing them into
-- durable places. A plaintext token column would be the third.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · SCOPE ENUM
-- ---------------------------------------------------------------------
-- ⚠️ READ_ONLY IS THE DEFAULT AND SHOULD STAY THE DEFAULT.
--
-- An assistant that can only read is useful and cannot damage anything.
-- An assistant that can write needs a person to have decided that on
-- purpose. Defaulting to read_write would mean the safe choice requires
-- an action, and the dangerous one requires nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mcp_scope') THEN
    CREATE TYPE public.mcp_scope AS ENUM ('read_only', 'read_write');
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2 · THE TOKENS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mcp_tokens (
    id              uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id       uuid NOT NULL,

    -- Human label. "Sahil's laptop", "Ops assistant".
    label           varchar(120) NOT NULL,

    -- ⚠️ SHA-256 of the token. 64 lowercase hex characters, always.
    token_hash      char(64) NOT NULL,

    -- First 8 characters of the token, for identification in a list.
    -- Not a secret: 8 characters of a 256-bit token is not guessable.
    token_prefix    varchar(12) NOT NULL,

    scope           public.mcp_scope DEFAULT 'read_only' NOT NULL,

    -- ⭐ THE ACTING USER. Every MCP call is attributed to a real person.
    --
    -- ⚠️ NOT NULLABLE, DELIBERATELY. An audit row saying "the AI did it"
    -- names nobody. Somebody authorised this token, and the audit trail
    -- has to be able to say who — otherwise the first question after an
    -- incident ("who let it do that?") has no answer.
    acting_user_id  uuid NOT NULL,

    created_at      timestamptz DEFAULT now() NOT NULL,
    created_by      uuid,
    last_used_at    timestamptz,
    expires_at      timestamptz,
    revoked_at      timestamptz,
    revoked_reason  text,

    -- Cheap abuse signal. A token doing 40,000 calls is not a person
    -- asking questions.
    call_count      bigint DEFAULT 0 NOT NULL,

    CONSTRAINT mcp_tokens_pkey PRIMARY KEY (id),

    -- ⚠️ The composite key every other table's FKs use. Without it a
    -- cross-tenant reference is representable.
    CONSTRAINT mcp_tokens_id_tenant_key UNIQUE (id, tenant_id),

    -- A hash collision across tenants would be a cross-tenant login.
    CONSTRAINT mcp_tokens_hash_unique UNIQUE (token_hash),

    CONSTRAINT mcp_tokens_hash_is_sha256
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT mcp_tokens_revocation_explained
        CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL),

    CONSTRAINT mcp_tokens_expiry_after_creation
        CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS mcp_tokens_tenant_idx
    ON public.mcp_tokens (tenant_id, revoked_at);

CREATE INDEX IF NOT EXISTS mcp_tokens_hash_idx
    ON public.mcp_tokens (token_hash);


-- ---------------------------------------------------------------------
-- 3 · THE CALL LOG
-- ---------------------------------------------------------------------
-- ⭐ EVERY MCP CALL IS LOGGED, INCLUDING THE ONES THAT WERE REFUSED.
--
-- ⚠️ THE REFUSALS ARE THE POINT. A log of only successful calls answers
-- "what did it do" and cannot answer "what did it try to do". An
-- assistant repeatedly attempting a write with a read-only token is the
-- single clearest signal that something is wrong — a prompt injection,
-- a misconfigured client, or a person testing the edges — and it is
-- invisible if refusals are not recorded.
CREATE TABLE IF NOT EXISTS public.mcp_call_log (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id      uuid NOT NULL,
    token_id       uuid,
    tool_name      varchar(120) NOT NULL,
    occurred_at    timestamptz DEFAULT now() NOT NULL,
    duration_ms    integer,
    outcome        varchar(20) NOT NULL,
    refusal_reason text,

    -- ⚠️ ARGUMENT KEYS ONLY, NEVER ARGUMENT VALUES.
    --
    -- A tool argument can be a customer's name, a phone number, or a
    -- contract value. Storing values would turn this diagnostic log into
    -- a second, unprotected copy of the tenant's data — and one that no
    -- retention policy covers. Key names alone are enough to debug a
    -- malformed call.
    argument_keys  text[],

    CONSTRAINT mcp_call_log_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_call_log_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT mcp_call_log_outcome_known
        CHECK (outcome IN ('ok', 'refused', 'error')),
    CONSTRAINT mcp_call_log_refusal_explained
        CHECK (outcome <> 'refused' OR refusal_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mcp_call_log_tenant_time_idx
    ON public.mcp_call_log (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mcp_call_log_outcome_idx
    ON public.mcp_call_log (tenant_id, outcome, occurred_at DESC);


-- ---------------------------------------------------------------------
-- 4 · THE CALL LOG IS APPEND-ONLY
-- ---------------------------------------------------------------------
-- ⚠️ A LOG THAT CAN BE EDITED IS NOT EVIDENCE.
--
-- If an assistant with a compromised token can also delete the record of
-- what it did, the log protects nobody. Same reasoning as `audit_logs`
-- and the security-event tables.
CREATE OR REPLACE FUNCTION public.mcp_call_log_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'mcp_call_log is append-only. A record of what an assistant did that '
    'the assistant could later edit is not a record. Insert a correcting '
    'row if something needs saying.';
END $$;

DROP TRIGGER IF EXISTS mcp_call_log_no_update ON public.mcp_call_log;
CREATE TRIGGER mcp_call_log_no_update
  BEFORE UPDATE OR DELETE ON public.mcp_call_log
  FOR EACH ROW EXECUTE FUNCTION public.mcp_call_log_block_mutation();


-- ---------------------------------------------------------------------
-- 5 · A REVOKED TOKEN STAYS REVOKED
-- ---------------------------------------------------------------------
-- ⚠️ UN-REVOKING IS NOT AN OPERATION.
--
-- A token is revoked because it leaked, or because somebody left. If
-- "revoked" can be undone by an UPDATE, then whoever holds the leaked
-- token has a path back the moment they also reach the database or a
-- support tool. Issue a new token; there is no cost to doing so.
CREATE OR REPLACE FUNCTION public.mcp_token_guard_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION
      'MCP token % was revoked on %. A revoked token cannot be brought '
      'back — it was revoked because it leaked or because somebody left, '
      'and reversing that hands the path back to whoever holds it. '
      'Issue a new token instead.',
      OLD.token_prefix, OLD.revoked_at;
  END IF;

  -- The hash is the identity. Changing it turns one token into another
  -- while keeping its history, scope and attribution.
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION
      'An MCP token hash cannot be changed. That would silently re-point '
      'an existing grant at a different secret.';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'An MCP token cannot be moved between tenants.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mcp_tokens_010_guard_revocation ON public.mcp_tokens;
CREATE TRIGGER mcp_tokens_010_guard_revocation
  BEFORE UPDATE ON public.mcp_tokens
  FOR EACH ROW EXECUTE FUNCTION public.mcp_token_guard_revocation();


-- ---------------------------------------------------------------------
-- 6 · ROW-LEVEL SECURITY
-- ---------------------------------------------------------------------
-- Same shape as every other tenant table: ENABLE *and* FORCE, with a
-- policy on both USING and WITH CHECK. FORCE is what makes the rule
-- apply to the table owner too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mcp_tokens', 'mcp_call_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND policyname = t || '_tenant_isolation'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY %I ON %I
          USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      $f$, t || '_tenant_isolation', t);
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- 7 · THE TOKEN RESOLVER — the one deliberate RLS bypass
-- ---------------------------------------------------------------------
-- 🔴 CHICKEN AND EGG, AND WHY THIS FUNCTION HAS TO EXIST.
--
-- Row-level security on `mcp_tokens` keys off `app.current_tenant_id`.
-- But an incoming MCP request carries ONLY a bearer token — we do not
-- know which tenant it belongs to until we have read the row, and we
-- cannot read the row until we know the tenant.
--
-- Three ways out, two of them wrong:
--
--   ❌ Put the tenant id in the token string. Then the client asserts
--      its own tenant, which is precisely the header-spoofing attack
--      `middleware.ts` strips six headers to prevent.
--   ❌ Exempt `mcp_tokens` from RLS. That leaves a table of live
--      credentials readable across tenants forever, to fix a problem
--      that lasts one query.
--   ✅ ONE `SECURITY DEFINER` function, doing ONE lookup, returning ONLY
--      what the caller needs to establish a context.
--
-- ⚠️ WHY THIS IS SAFE, PRECISELY:
--   • It takes a SHA-256 hash, not a token, and not a tenant id. You
--     cannot enumerate with it — you must already hold the secret.
--   • It returns NO SECRET. Not the hash, not the label, not the count.
--   • It applies expiry and revocation ITSELF, so a caller cannot
--     "forget" to check. A revoked token resolves to zero rows.
--   • `search_path` is pinned, so it cannot be hijacked by a shadowing
--     schema.
--   • It is the ONLY function in this file that is SECURITY DEFINER, and
--     it exists for exactly one query at the edge of the request.
CREATE OR REPLACE FUNCTION public.mcp_resolve_token(p_token_hash text)
RETURNS TABLE (
    token_id       uuid,
    tenant_id      uuid,
    scope          public.mcp_scope,
    acting_user_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
    SELECT t.id, t.tenant_id, t.scope, t.acting_user_id
      FROM public.mcp_tokens t
     WHERE t.token_hash = p_token_hash
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > now())
     LIMIT 1;
$$;

-- ⚠️ EXECUTE is granted to PUBLIC deliberately: the application role
-- must be able to call it before any tenant context exists. The safety
-- is in what the function returns, not in who may call it — a caller
-- without the hash learns nothing.
COMMENT ON FUNCTION public.mcp_resolve_token(text) IS
  'Resolves an MCP bearer-token SHA-256 hash to a tenant context. '
  'SECURITY DEFINER by necessity: RLS cannot be satisfied before the '
  'tenant is known. Returns no secret and enforces revocation and '
  'expiry itself.';


-- ---------------------------------------------------------------------
-- 8 · THE OPERATOR'S VIEW
-- ---------------------------------------------------------------------
-- ⚠️ `security_invoker = true` IS NOT OPTIONAL.
--
-- Without it this view executes as its OWNER, row-level security is
-- silently skipped, and every tenant sees every other tenant's MCP
-- activity. The view would look completely correct while doing it.
CREATE OR REPLACE VIEW public.v_mcp_activity
WITH (security_invoker = true) AS
SELECT
    t.id                                        AS token_id,
    t.tenant_id,
    t.label,
    t.token_prefix,
    t.scope,
    t.created_at,
    t.last_used_at,
    t.expires_at,
    t.revoked_at,
    t.call_count,
    CASE
        WHEN t.revoked_at IS NOT NULL              THEN 'revoked'
        WHEN t.expires_at IS NOT NULL
             AND t.expires_at <= now()             THEN 'expired'
        ELSE 'active'
    END                                         AS state,
    COALESCE(l.refused_24h, 0)                  AS refused_last_24h,
    COALESCE(l.errors_24h, 0)                   AS errors_last_24h
FROM public.mcp_tokens t
LEFT JOIN LATERAL (
    SELECT
        count(*) FILTER (WHERE outcome = 'refused') AS refused_24h,
        count(*) FILTER (WHERE outcome = 'error')   AS errors_24h
    FROM public.mcp_call_log cl
    WHERE cl.tenant_id = t.tenant_id
      AND cl.token_id  = t.id
      AND cl.occurred_at > now() - interval '24 hours'
) l ON true;


-- =====================================================================
-- VERIFY — paste this separately after running the file above.
-- Every row should say OK.
-- =====================================================================
-- SELECT 'mcp_tokens exists'      AS check,
--        CASE WHEN to_regclass('public.mcp_tokens') IS NOT NULL
--             THEN 'OK' ELSE 'MISSING' END AS result
-- UNION ALL SELECT 'mcp_call_log exists',
--        CASE WHEN to_regclass('public.mcp_call_log') IS NOT NULL
--             THEN 'OK' ELSE 'MISSING' END
-- UNION ALL SELECT 'both have RLS FORCED',
--        CASE WHEN (SELECT count(*) FROM pg_class c
--                    JOIN pg_namespace n ON n.oid = c.relnamespace
--                   WHERE n.nspname='public'
--                     AND c.relname IN ('mcp_tokens','mcp_call_log')
--                     AND c.relforcerowsecurity) = 2
--             THEN 'OK' ELSE 'NOT FORCED' END
-- UNION ALL SELECT 'view uses security_invoker',
--        CASE WHEN (SELECT option_value FROM pg_class c
--                    JOIN pg_namespace n ON n.oid = c.relnamespace,
--                    LATERAL pg_options_to_table(c.reloptions)
--                   WHERE n.nspname='public' AND c.relname='v_mcp_activity'
--                     AND option_name='security_invoker') = 'true'
--             THEN 'OK' ELSE 'MISSING — VIEW BYPASSES RLS' END;
