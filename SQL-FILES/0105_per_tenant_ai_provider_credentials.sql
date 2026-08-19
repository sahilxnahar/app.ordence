-- ############################################################################
-- 0105 , PER-TENANT AI PROVIDER CREDENTIALS (BRING YOUR OWN KEY)
-- ############################################################################
--
-- PURPOSE
-- -------
-- Until this file there was exactly ONE AI key per deployment. lib/ai/client.ts
-- read `process.env[provider.envVar]` at the moment of the call, and there was
-- no tenant dimension anywhere in the path. Every workspace on the platform
-- shared one key, one free-tier budget, one rate limit and one circuit breaker.
--
-- A heavy tenant therefore degraded the assistant for every other customer,
-- the founder paid for all of it, and one customer's dead key would have
-- tripped the breaker for everybody.
--
-- This file adds the table that lets a workspace bring its own.
--
-- ############################################################################
-- THE TABLE HOLDS NO KEY, AND THAT IS THE WHOLE DESIGN
-- ############################################################################
--
-- There is no api_key column below and there must never be one. The key itself
-- goes into `vault_secrets` (0037, armed in v1.12.0 by server/vault/crypto.ts):
-- AES-256-GCM, the encryption key NAMED rather than kept, an HMAC blind index
-- under a pepper that is not in this database, a masked display column, and an
-- append-only access log no application role may delete. It is stored under
--
--     owner_kind = 'ai_provider_credential'
--     owner_id   = ai_provider_credentials.id
--     label      = 'api_key'
--
-- which is the exact shape a connection's credential already uses. A second
-- place that holds secrets is a second set of rules about secrets, and the
-- looser one wins the moment somebody imports the wrong module.
--
-- So this row is everything about the credential that is NOT the credential:
-- which provider, whether it works, when it last did, and the Cloudflare
-- account id that has to travel beside a Cloudflare token.
--
-- ############################################################################
-- AND IT IS THE ACCOUNTING RECORD FOR THE READ
-- ############################################################################
--
-- server/vault/secrets.ts states the rule: a decryption with no record anywhere
-- is the one thing 0037 exists to make impossible. It also states the exception
-- and the reason for it , a poller reading its key 240 times a day would bury
-- the handful of reads where a PERSON opened a credential, so `readForRunner`
-- is accounted for by its `sync_runs` row instead of by 240 log rows.
--
-- An AI call is the same animal and more so: the assistant may make a dozen
-- provider calls in one conversation. last_used_at, use_count and the
-- last_failure_* triple below are this credential's `sync_runs`. That is why
-- they are columns on a table and not a cache.
--
-- ############################################################################
-- THERE IS NO `lane` COLUMN AND THERE MUST NOT BE
-- ############################################################################
--
-- lib/ai/providers.ts splits providers into two lanes. `confidential` is
-- Cloudflare Workers AI alone and is the only lane permitted to see tenant
-- data; `open` is Groq, Cerebras, Gemini, Mistral, Cohere, GitHub Models and
-- OpenRouter, several of which declare mayTrainOnInputs: true.
--
-- A tenant may reasonably say "it is my data and my key, let me choose". The
-- answer is NO, and a lane column here is exactly how that no would be
-- reversed by a later hurried edit. The argument is set out in full in
-- laneForCredential() in lib/ai/credentials.ts, and summarised here because
-- a person reading the schema is entitled to it:
--
--   1. The lane is about where the data GOES, not about who PAYS. Groq's terms
--      do not change because the request was billed to the customer.
--   2. The data is not the tenant's to give away. A workspace holds its
--      customers' phone numbers and its employees' salaries. Under the DPDPA
--      2023 the workspace is the Data Fiduciary for those people, and a tick
--      box in Settings cannot furnish s.6 consent on behalf of four thousand
--      contacts who have never heard of Cerebras.
--   3. The honest answer is not "no", it is "yes, with a confidential-lane
--      key". Cloudflare Workers AI is self-service and the registry already
--      carries the URL to get a token. The customer gets their own budget and
--      their own breaker for tenant work, and the lane holds.
--
-- ############################################################################
-- WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0104. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own connection. `BEGIN`
-- buys no atomicity across that boundary; it only makes a half-applied file
-- look like a clean one, which is exactly how 0091 applied half-way while
-- reporting success and cost three rounds of debugging the wrong thing.
-- `SET LOCAL app.platform_scope` reports "executed successfully" and has
-- evaporated by the time the next statement runs.
--
-- Every statement below is independently idempotent , CREATE TABLE IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE
-- POLICY , and the file is safe to re-run from the top after a failure at any
-- point.
--
-- AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. Nothing
-- below writes a row, so nothing below can be refused by a FORCE ROW LEVEL
-- SECURITY policy , the failure mode 0091 and 0092 both hit. No backfill is
-- needed either: no workspace has ever had its own AI key, so there is nothing
-- to migrate and inventing a row would be inventing a credential.
--
-- RUN ORDER: after 0104. Re-runnable. No code depends on it having run before
-- the code is pushed , see the note at the end of section 6.
-- DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started. A file whose most valuable output
-- sits behind its least certain operation teaches you nothing on the day it
-- breaks.
--
-- WHAT TO READ HERE:
--   running_as        must NOT be a superuser if you are testing a refusal.
--                     A drill run as `postgres` passes every refusal test and
--                     proves nothing.
--   vault_present     false means the whole feature cannot work: there is
--                     nowhere to put the key. Stop and fix that first.
--   already_present   true on a re-run. Everything below is a no-op then.
--   existing_rows     how many workspaces already supplied a key. Zero on the
--                     first run, by definition.
--
-- NOTE ON THE GUARD SHAPE, AND ON A MISTAKE THIS FILE MADE FIRST:
--
-- The `existing_rows` count is wrapped in a CASE over to_regclass that chooses
-- between two STRINGS, not between two queries. A CASE over relations is worse
-- than no guard: the planner resolves BOTH branches before the guard runs, so
-- naming a table that does not exist in a FROM clause fails whatever the CASE
-- decides. query_to_xml is not an existence guard either , it defers PLANNING,
-- not EXISTENCE, and the string still executes.
--
-- THE MISTAKE: the first draft used `'SELECT 1 WHERE false'` as the absent
-- branch and counted rows out of xmltable. query_to_xml over a query that
-- returns NO ROWS produces an EMPTY DOCUMENT, and xmltable then fails with
--
--     ERROR:  could not parse XML document
--     DETAIL:  line 1: Document is empty
--
-- So the DIAGNOSTIC , the section that exists precisely so the operator learns
-- something on the day the rest of the file breaks , was the one statement in
-- the file that could not run. It was caught by executing this file the way it
-- is actually used, statement by statement on its own connection as a
-- non-superuser, and by nothing else: it reads correctly, and psql -f would
-- have hit it too but only because it runs the same statement.
--
-- BOTH BRANCHES NOW RETURN EXACTLY ONE ROW, so the document is never empty.
-- ============================================================================

SELECT
    '0105 · diagnostic'                                             AS finding,
    current_user                                                    AS running_as,
    (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
    to_regclass('public.tenants')                 IS NOT NULL       AS tenants_present,
    to_regclass('public.vault_secrets')           IS NOT NULL       AS vault_present,
    to_regclass('public.ai_provider_credentials') IS NOT NULL       AS already_present,
    (
        SELECT (xpath(
                  '/row/n/text()',
                  query_to_xml(
                    CASE
                      WHEN to_regclass('public.ai_provider_credentials') IS NULL
                        -- One row, so the document is never empty.
                        THEN 'SELECT 0 AS n'
                        ELSE 'SELECT count(*)::int AS n FROM public.ai_provider_credentials'
                    END,
                    false, true, ''
                  )
                ))[1]::text::int
    )                                                               AS existing_rows;


-- ============================================================================
-- SECTION 2 · THE TABLE
-- ============================================================================
-- NO api_key COLUMN. See the header. The key is in vault_secrets under
-- owner_kind = 'ai_provider_credential'.
--
-- provider_id IS A varchar AND NOT AN ENUM OR A FOREIGN KEY. The provider
-- registry is lib/ai/providers.ts, a frozen constant in the application. A
-- Postgres enum would need an ALTER TYPE every time a provider is added , a
-- migration to add an item to a list that is already a list , and a lookup
-- table would be a second copy of the registry that drifts. The application
-- validates against PROVIDERS_BY_ID before it writes, and the resolver skips
-- an id it does not recognise rather than crashing on it.
--
-- status = 'failing' IS SET BY THE ROUTER, NOT BY A PERSON. It is what makes
-- "your key stopped working" visible on a screen nobody was looking at when it
-- happened. It does NOT stop the key being tried: a key that failed once at
-- 3am and works now must not need a human to switch it back on. 'disabled' is
-- the only state a person sets and the only one that stops the key being used.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_provider_credentials (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    provider_id           varchar(60) NOT NULL,

    -- Cloudflare's account id. NOT a secret; NOT optional for that provider.
    -- See the constraint at the bottom of this statement and section 3.
    account_id            varchar(120),

    status                varchar(20) NOT NULL DEFAULT 'active',

    -- What actually happened. This is the accounting record for the vault
    -- read; see the header.
    last_success_at       timestamptz,
    last_used_at          timestamptz,
    -- A COUNT, not money. The house rule about paise and `_minor` suffixes
    -- does not apply and the absence of the suffix is deliberate.
    use_count             bigint      NOT NULL DEFAULT 0,

    last_failure_at       timestamptz,
    -- auth | quota | rate_limited | misconfigured | unreachable | error.
    -- 'auth' AND 'rate_limited' ARE SEPARATE VALUES BECAUSE THEY ARE SEPARATE
    -- EVENTS: one clears by itself in sixty seconds, the other never clears
    -- until a person re-enters a key. A screen that shows them the same way
    -- tells the customer to wait for something that will not happen.
    last_failure_kind     varchar(30),
    -- THE PROVIDER'S OWN WORDS, TRUNCATED BY THE APPLICATION. Safe by
    -- construction: it is a RESPONSE body. The key travels in a request header
    -- and is never in anything read back.
    last_failure_message  text,

    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT ai_provider_credentials_status_valid
        CHECK (status IN ('active', 'disabled', 'failing')),

    CONSTRAINT ai_provider_credentials_use_count_non_negative
        CHECK (use_count >= 0),

    -- THE PAIR THAT MUST NOT BE HALF-ENTERED. lib/ai/client.ts interpolates
    -- the account id into
    --   https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1
    -- With a token and no account id the URL carries an EMPTY path segment,
    -- every call fails, the router walks on, and nothing anywhere says why.
    -- This is the third of three refusals; the action refuses it first with a
    -- sentence a person can act on, and the resolver refuses to hand out a
    -- half credential. This one catches anything that reaches the table
    -- another way.
    CONSTRAINT ai_provider_credentials_cloudflare_needs_account
        CHECK (provider_id <> 'cloudflare_workers_ai'
               OR (account_id IS NOT NULL AND length(btrim(account_id)) > 0))
);

COMMENT ON TABLE public.ai_provider_credentials IS
    'Which AI providers a workspace has supplied its own key for. Holds NO '
    'key: the secret is in vault_secrets under owner_kind = '
    '''ai_provider_credential''. There is deliberately no lane column , the '
    'lane is a property of the provider, not of the payer, and a per-tenant '
    'lane is how the confidential-lane rule would get reversed.';

COMMENT ON COLUMN public.ai_provider_credentials.account_id IS
    'Cloudflare account id. Not a secret. Not optional for '
    'cloudflare_workers_ai: without it the request URL is built with an empty '
    'account segment and every call fails silently.';

COMMENT ON COLUMN public.ai_provider_credentials.last_used_at IS
    'The accounting record for reading this key out of the vault, in place of '
    'an access-log row per AI call. Same argument server/vault/secrets.ts '
    'makes for readForRunner and sync_runs.';

COMMENT ON COLUMN public.ai_provider_credentials.status IS
    '''failing'' is set by the router and does NOT stop the key being tried. '
    '''disabled'' is the only state a person sets and the only one that does.';

-- Composite, so a tenant-scoped foreign key can be added later without
-- reopening this file.
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_credentials_id_tenant_key
    ON public.ai_provider_credentials (id, tenant_id);

-- ONE ROW PER PROVIDER PER WORKSPACE. Two rows would mean two vault secrets
-- under two owner ids and a resolver picking one by created_at , the shape
-- where rotating a key leaves the old one live and nobody can tell which is in
-- use. Rotation supersedes the vault row; this row is updated in place.
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_credentials_provider_key
    ON public.ai_provider_credentials (tenant_id, provider_id);

CREATE INDEX IF NOT EXISTS ai_provider_credentials_status_idx
    ON public.ai_provider_credentials (tenant_id, status);


-- ============================================================================
-- SECTION 3 · ROW LEVEL SECURITY
-- ============================================================================
-- This table carries tenant_id, so check-rls-coverage requires ENABLE, FORCE,
-- and a policy whose USING names app_current_tenant_id().
--
-- FORCE MATTERS MORE THAN ENABLE HERE. Plain ENABLE does not apply to the
-- table OWNER, and a migration runs as the owner. FORCE exists precisely so
-- the owner is not exempt , without it the isolation would be a comment rather
-- than a control.
--
-- AND THERE IS NO PLATFORM CLAUSE, DELIBERATELY, WHICH IS THE OPPOSITE OF
-- WHAT 0102 DID FOR bank_reconciliation_items.
--
-- A workspace's AI key is that workspace's own property. Ordence staff have no
-- operational reason to read the ROW , they cannot read the KEY in any case,
-- because the vault holds it and the vault's own policy governs that. Adding
-- `OR app_platform_scope()` to the USING clause would let a support session
-- enumerate which customers have brought their own keys and for which
-- providers, which is commercially sensitive and answers no support question
-- that the customer could not answer themselves.
--
-- If a support engineer ever genuinely needs it, the route is
-- readForPerson() in server/vault/secrets.ts , which demands a stated reason
-- of at least twenty characters and writes it to a log nobody can delete , not
-- a widened policy here.
-- ============================================================================

ALTER TABLE public.ai_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_credentials FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_credentials_tenant_isolation
    ON public.ai_provider_credentials;

CREATE POLICY ai_provider_credentials_tenant_isolation
    ON public.ai_provider_credentials
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 4 · GRANTS
-- ============================================================================
-- DELETE IS GRANTED, AND THAT IS A DEPARTURE FROM THE VAULT'S OWN RULE.
--
-- 0037 revokes DELETE on vault_secrets from the application role, because an
-- absence proves nothing: it is indistinguishable from never having held the
-- credential and from having quietly moved it somewhere else. That reasoning
-- is about THE SECRET, and it still holds , removing a key from this workspace
-- calls ordence_vault_erase(), which zeroes the ciphertext and KEEPS the vault
-- row as the receipt.
--
-- This row is not the secret. It is a preference: "this workspace uses its own
-- Groq key". A customer who removes their key and later adds it again would
-- otherwise accumulate tombstones on a settings screen, and the unique index
-- on (tenant_id, provider_id) would refuse the second add. The evidence lives
-- where evidence belongs , in vault_secrets, which cannot be deleted, and in
-- audit_logs, which is append-only.
--
-- 0087 GRANTED bank_line_matches WITHOUT DELETE CITING A GUARD TRIGGER THAT
-- DID NOT EXIST, and 0102 had to correct it. So, stated plainly and checkable:
-- there is NO trigger on this table, none is claimed, and DELETE is refused
-- for rows of other tenants by the RLS policy in section 3 and by nothing else.
-- ============================================================================

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.ai_provider_credentials TO ordence_app;
    END IF;
END;
$grants$;


-- ============================================================================
-- SECTION 5 · VERIFICATION · READ ONLY · RUN THIS LAST AND READ IT
-- ============================================================================
-- EVERY COLUMN BELOW SHOULD READ true, AND `policies_present` SHOULD READ 1.
--
-- A false in rls_enabled_and_forced is the failure that has no symptom: the
-- table works, the queries filter on tenant_id correctly, and the database has
-- simply stopped refusing a query that forgets to. That is the whole tenant
-- boundary in this product.
--
-- A false in cloudflare_constraint_present means a workspace can store a
-- Cloudflare token with no account id, which produces a provider that fails
-- every call and reports nothing.
-- ============================================================================

SELECT
    '0105 · verification'                                            AS finding,
    to_regclass('public.ai_provider_credentials') IS NOT NULL        AS table_present,
    (SELECT c.relrowsecurity AND c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'ai_provider_credentials')                   AS rls_enabled_and_forced,
    (SELECT count(*)
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'ai_provider_credentials')                  AS policies_present,
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'ai_provider_credentials_cloudflare_needs_account')
                                                                     AS cloudflare_constraint_present,
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'ai_provider_credentials_status_valid')  AS status_constraint_present,
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname  = 'ai_provider_credentials_provider_key')
                                                                     AS one_row_per_provider_enforced,
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name   = 'ai_provider_credentials'
                   AND column_name IN ('api_key', 'ciphertext', 'secret', 'token', 'lane'))
                                                                     AS holds_no_key_and_no_lane;


-- ============================================================================
-- SECTION 6 · ORDER RELATIVE TO THE CODE PUSH
-- ============================================================================
-- RUN THIS FILE FIRST, THEN PUSH THE CODE. But either order is survivable, and
-- that is deliberate rather than lucky:
--
--   SQL FIRST, CODE LATER   , the table sits empty and nothing reads it. No
--                             behaviour changes at all.
--   CODE FIRST, SQL LATER   , server/ai/credentials.ts catches a missing-table
--                             error from its own SELECT and returns the
--                             platform credential set, which is exactly
--                             today's behaviour. The settings screen shows a
--                             banner saying migration 0105 has not been
--                             applied. The assistant keeps working.
--
-- THE SECOND CASE IS TESTED, NOT ASSUMED , see the "before 0105 is applied"
-- block in tests/ui/ai-tenant-credentials.test.ts. A fallback that has only
-- ever been run on the passing case is not a fallback.
-- ============================================================================
