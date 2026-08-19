-- ############################################################################
-- 0115 · WHOSE AI CREDITS, MADE STRUCTURAL — AND MEASURED
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.71.0-alpha   ·   Migration number: 0115
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY, AND IT IS ONE LINE
-- ############################################################################
--
-- `0105` built the whole per-tenant credential story: a row per workspace per
-- provider, the key itself in `vault_secrets` under AES-256-GCM, a settings
-- screen, a `disabled` state only a person can set, and `budget_scope` threaded
-- through every call precisely so — its own words —
--
--     "A tenant paying for their own Groq key must not spend the platform's
--      Groq budget."
--
-- ⚠️ AND THE RESOLVER STARTS FROM THE PLATFORM SET:
--
--     const byProvider = { ...platform.byProvider };   // ours go in FIRST
--     for (const row of rows) { /* theirs override */ }
--
-- 🔴 SO A WORKSPACE THAT CONFIGURED GROQ AND NOT GOOGLE REACHES GOOGLE ON
--    OUR KEY, SILENTLY. Not as a fallback anybody chose — as the shape of the
--    merge. `0105` was written to ADD bring-your-own; it was never asked to
--    make it exclusive.
--
-- ⚠️ AND NOTHING MEASURES ANY OF IT. `budget_scope` tracks provider HEALTH —
--    cooldowns after failures — not tokens and not money. "How much did that
--    workspace cost us last month" has no answer, approximate or otherwise.
--
-- ############################################################################
-- ⭐⭐⭐ THE POLICY, AND WHY IT IS A COLUMN ON `tenants`
-- ############################################################################
--
-- Three values. The resolver reads it and nothing else does, so a caller
-- cannot forget it:
--
--   platform_allowed  today's behaviour. Our keys sit under theirs.
--   byo_preferred     theirs first; ours only for a provider they have not
--                     configured, AND every such call is metered and shown to
--                     them. Nothing is silent.
--   byo_required      🔴 our keys are not in their set AT ALL. A provider they
--                     have not configured is unavailable, and the refusal
--                     names the fix.
--
-- ⚠️ ON `tenants` AND NOT IN `tenants.settings` JSONB. The resolver runs on
--    every AI call and a jsonb probe is not free; more importantly a CHECK
--    constraint can police a column and cannot police a key inside a document.
--    A policy the database cannot spell-check is a policy that eventually
--    reads `"byo-required"` and silently means `platform_allowed`.
--
-- ############################################################################
-- 🔴🔴 THE GRANDFATHER, AND IT IS THE DANGEROUS PART OF THIS FILE
-- ############################################################################
--
-- The owner's decision is BYO REQUIRED FROM DAY ONE. Taken literally, that
-- means adding this column with `NOT NULL DEFAULT 'byo_required'` — which
-- backfills EVERY EXISTING ROW and cuts off every workspace currently using
-- the assistant, in the same second, with no warning to them and no list for
-- us.
--
-- ⭐ SO NEW WORKSPACES DEFAULT TO `byo_required` AND EXISTING ONES ARE
--    GRANDFATHERED TO `platform_allowed`. That is not a softening of the
--    decision; it is the decision applied without breaking people who signed
--    up under the old one. The verdict at the bottom reports exactly how many
--    were grandfathered, so flipping them is a choice somebody makes with the
--    number in front of them rather than a side effect of a deploy.
--
-- ⚠️ THE ORDER MATTERS AND IS DELIBERATE. Nullable → backfill → default →
--    NOT NULL. A workspace created in the seconds between the backfill and
--    `SET NOT NULL` would carry NULL and fail the constraint, so the backfill
--    is repeated immediately before it. Such a workspace is grandfathered,
--    which is the safe direction: it keeps working and appears in the count.
--
-- ############################################################################
-- SAFE TO RUN TWICE. No BEGIN, no COMMIT, no bare SET LOCAL.
-- ############################################################################


-- ============================================================================
-- ① THE POLICY COLUMN — NULLABLE FIRST
-- ============================================================================

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS ai_credential_policy varchar(20);


-- ============================================================================
-- ② GRANDFATHER EVERY WORKSPACE THAT ALREADY EXISTS
-- ============================================================================
--
-- ⚠️ `WHERE ai_credential_policy IS NULL` MAKES THIS IDEMPOTENT AND MAKES IT
--    SAFE TO REPEAT. A second run touches nothing, and a workspace created
--    between statements is caught by the repeat in ④.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 AND IT IS INSIDE A `DO` BLOCK WITH `app.platform_scope` SET, BECAUSE
--    `tenants` HAS FORCE ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════════
-- `check:sql-rls-writes` refused the first draft of this file, correctly: a
-- bare UPDATE on `tenants` is rejected with "new row violates row-level
-- security policy" for any role without BYPASSRLS — which `ordence_app` is,
-- deliberately. The migration would have appeared to run and grandfathered
-- nobody.
--
-- ⚠️ AND `SET LOCAL app.platform_scope = 'on';` AS ITS OWN STATEMENT DOES NOT
--    WORK HERE. The Neon console gives every statement its own connection and
--    therefore its own transaction, so a `SET LOCAL` in one statement is gone
--    by the next. `PERFORM set_config(..., true)` inside the same `DO` block
--    as the write is the only shape that holds. `0091` uses it four times for
--    the same reason.

DO $grandfather$
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    UPDATE public.tenants
       SET ai_credential_policy = 'platform_allowed'
     WHERE ai_credential_policy IS NULL;
END
$grandfather$;


-- ============================================================================
-- ③ AND EVERY WORKSPACE FROM NOW ON BRINGS ITS OWN
-- ============================================================================

ALTER TABLE public.tenants
    ALTER COLUMN ai_credential_policy SET DEFAULT 'byo_required';


-- ============================================================================
-- ④ THE REPEAT, THEN NOT NULL
-- ============================================================================

-- ⚠️ Same shape as ②, and for the same reason. A workspace created in the
--    seconds between the two carries NULL and would fail `SET NOT NULL`.

DO $grandfather_again$
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    UPDATE public.tenants
       SET ai_credential_policy = 'platform_allowed'
     WHERE ai_credential_policy IS NULL;
END
$grandfather_again$;

ALTER TABLE public.tenants
    ALTER COLUMN ai_credential_policy SET NOT NULL;


-- ============================================================================
-- ⑤ AND THE DATABASE SPELL-CHECKS IT
-- ============================================================================
--
-- 🔴 THE REASON THIS IS A CHECK AND NOT A CONVENTION. A typo in this column
--    does not fail — it falls through whatever `switch` the resolver uses and
--    silently means one of the three. The one it would silently mean is
--    `platform_allowed`, because that is what a default branch does, and that
--    is the outcome this entire file exists to prevent.

DO $c1$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenants_ai_credential_policy_known'
    ) THEN
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_ai_credential_policy_known
            CHECK (ai_credential_policy IN
                   ('platform_allowed', 'byo_preferred', 'byo_required'));
    END IF;
END
$c1$;

COMMENT ON COLUMN public.tenants.ai_credential_policy IS
    'byo_required: the platform''s keys are not in this workspace''s credential '
    'set at all, and a provider it has not configured is unavailable. '
    'byo_preferred: the platform''s keys are used only where the workspace has '
    'none, and every such call is metered and shown to them. platform_allowed: '
    'the pre-0115 behaviour. New workspaces default to byo_required; every '
    'workspace that existed when 0115 ran was grandfathered to '
    'platform_allowed so that nobody was cut off by a deploy.';


-- ============================================================================
-- ⑥ `ai_usage` · WHOSE CREDITS, AS A FACT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    occurred_at    timestamptz NOT NULL DEFAULT now(),

    provider_id    varchar(40) NOT NULL,
    model          varchar(120),

    -- 🔴 THE COLUMN THE WHOLE TABLE IS FOR. 'platform' means it was OUR key.
    --    Every row with this value is money that left our account for a
    --    workspace, and before 0115 that number was unknowable.
    credential_source varchar(16) NOT NULL,

    -- ⚠️ NULLABLE, BECAUSE NOT EVERY PROVIDER RETURNS USAGE. A zero would be
    --    a measurement; NULL is the honest statement that the provider did not
    --    say. Summing NULLs as zero would understate our own spend and the
    --    understatement would be invisible.
    prompt_tokens     integer,
    completion_tokens integer,
    total_tokens      integer,

    -- ⭐ WHAT ASKED. Not a foreign key: the assistant conversation, the goal
    --    planner and a background sweep are three different subjects and this
    --    table must outlive all of them.
    feature        varchar(60) NOT NULL,
    request_ref    varchar(120),

    -- 🔴 FAILURES ARE RECORDED TOO. A call that was rejected after the prompt
    --    was sent has already cost tokens at the provider, and a table that
    --    only counted successes would report a workspace as cheap in exactly
    --    the month its key was broken and it retried all day.
    outcome        varchar(16) NOT NULL DEFAULT 'ok',
    failure_kind   varchar(40),

    CONSTRAINT ai_usage_source_known
        CHECK (credential_source IN ('platform', 'tenant')),

    CONSTRAINT ai_usage_outcome_known
        CHECK (outcome IN ('ok', 'failed', 'refused')),

    CONSTRAINT ai_usage_tokens_not_negative
        CHECK ((prompt_tokens     IS NULL OR prompt_tokens     >= 0)
           AND (completion_tokens IS NULL OR completion_tokens >= 0)
           AND (total_tokens      IS NULL OR total_tokens      >= 0)),

    -- ⚠️ A FAILURE SAYS WHY. Same discipline as every other refusal in this
    --    product: 'failed' with nothing beside it is a row nobody can act on.
    CONSTRAINT ai_usage_failure_named
        CHECK (outcome <> 'failed' OR failure_kind IS NOT NULL)
);

COMMENT ON TABLE public.ai_usage IS
    'One row per AI provider call. `credential_source` is the point of the '
    'table: rows marked platform are spend that left Ordence''s own account on '
    'a workspace''s behalf. Failures are recorded because a rejected call has '
    'already cost tokens, and a success-only table reports a workspace as '
    'cheapest in the month its key was broken.';

-- ⭐ THE QUESTION THIS TABLE EXISTS TO ANSWER, INDEXED: how much of OUR
--    budget did this workspace spend, this month.
CREATE INDEX IF NOT EXISTS ai_usage_platform_spend_idx
    ON public.ai_usage (tenant_id, occurred_at DESC)
 WHERE credential_source = 'platform';

CREATE INDEX IF NOT EXISTS ai_usage_tenant_period_idx
    ON public.ai_usage (tenant_id, occurred_at DESC);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_usage_tenant_isolation ON public.ai_usage;
CREATE POLICY ai_usage_tenant_isolation
    ON public.ai_usage
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ⑦ 🔴 THE GUARD · A USAGE ROW IS A MEASUREMENT, NOT A DRAFT
-- ============================================================================
--
-- ⚠️ IT IS APPEND-ONLY. A metering table somebody can edit is a metering table
--    nobody can quote in a billing conversation, and the edit that would be
--    made is always the one that lowers a number.

CREATE OR REPLACE FUNCTION public.ordence_guard_ai_usage_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
    RAISE EXCEPTION
        'ai_usage is append-only. It is what a billing conversation is settled against, and the edit somebody wants to make is always the one that lowers a number. A measurement that was wrong is corrected by recording the correction, not by changing the original.'
        USING ERRCODE = 'raise_exception';
END
$guard$;

DROP TRIGGER IF EXISTS ordence_guard_ai_usage_append_only ON public.ai_usage;

CREATE TRIGGER ordence_guard_ai_usage_append_only
    BEFORE UPDATE OR DELETE ON public.ai_usage
    FOR EACH ROW EXECUTE FUNCTION public.ordence_guard_ai_usage_append_only();


-- ============================================================================
-- ⑧ THE VERDICT — AND READ THE LAST COLUMN
-- ============================================================================
--
-- ⚠️ ONE STATEMENT, SINGLE-QUOTED LITERAL. See 0101.

SELECT
    'SQL 0115 · AI credential policy and usage'                           AS migration,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name = 'ai_credential_policy')                         AS policy_column_expect_1,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ai_usage')          AS usage_table_expect_1,
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'ordence_guard_ai_usage_append_only')                AS guard_expect_1,
    (SELECT count(*) FROM public.tenants
      WHERE ai_credential_policy = 'byo_required')                        AS workspaces_bringing_their_own,
    -- 🔴 READ THIS ONE. Every workspace here is still able to spend YOUR AI
    --    budget. They were grandfathered so that this deploy did not cut them
    --    off mid-sentence. Moving them is a decision, and it is now a decision
    --    you can make with the number in front of you.
    (SELECT count(*) FROM public.tenants
      WHERE ai_credential_policy = 'platform_allowed')                    AS grandfathered_still_on_your_keys;
