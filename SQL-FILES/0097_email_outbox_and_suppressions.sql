-- ############################################################################
-- 0097 , THE MAIL OUTBOX AND THE SUPPRESSION LIST
-- ############################################################################
--
-- PURPOSE
-- -------
-- 🔴 FOUR PLACES IN THIS PRODUCT WRITE A MESSAGE INTO A QUEUE AND NOTHING
--    EMPTIES IT. The most expensive is the dunning sweep:
--    `server/actions/credit.ts` inserts into `credit_dunning_log` with
--    `delivery = 'queued'` and its own header says, verbatim:
--
--        "IT QUEUES. IT DOES NOT SEND. There is no SMTP call, no Resend call
--         and no webhook anywhere below."
--
--    The comment was honest and the code was correct as far as it went. What
--    did not exist was the drain. So the screen reported "reminder recorded",
--    the customer received nothing, the invoice aged, and the owner believed
--    they were chasing money they were not chasing.
--
-- ⭐ THIS FILE ADDS THE TWO TABLES THAT MAKE SENDING SAFE, AND NOTHING ELSE.
--    The sending itself is `server/email/outbox.ts`; the rules it applies are
--    `lib/email/outbox.ts`.
--
-- ############################################################################
-- 🔴 WHY `email_suppressions.tenant_id` IS NULLABLE , THE ONLY ONE IN THE
--     SCHEMA , AND WHY THAT IS NOT A HOLE IN TENANT ISOLATION
-- ############################################################################
--
-- A hard bounce is a fact about a MAILBOX, not about the workspace that
-- happened to write to it first. Every tenant's mail leaves under the sending
-- reputation of one domain, so an address that does not exist costs EVERY
-- tenant's delivery for as long as we keep offering it , including the
-- tenants doing nothing wrong. It is a shared resource, spent by whoever is
-- careless.
--
-- ⚠️ If the suppression were scoped to the discovering tenant, the second
--    tenant to mail that address would burn the same reputation again, and the
--    third, and the hundredth. Nobody would ever be at fault and delivery would
--    degrade for everyone.
--
-- ⭐ SO `tenant_id IS NULL` MEANS GLOBAL, and the policy is
--
--        USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id())
--
--    Every tenant READS the global list. A tenant may add its OWN suppression
--    (an operator saying "never mail this person again"), visible only to
--    itself. Only a transaction holding `app.platform_scope` may write a
--    GLOBAL row , which is what the bounce webhook runs under, because it has
--    no session and no tenant: a bounce belongs to nobody.
--
--    The USING clause still names `app_current_tenant_id()`, so
--    `check-rls-coverage` sees exactly the predicate it requires. This is not
--    an exempted table. It is a table where NULL means "everyone".
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Restated because the project has already lost a day to it. Migrations here
-- are PASTED INTO THE NEON BROWSER CONSOLE, which sends each statement on its
-- own connection turn. `BEGIN` buys no atomicity across that boundary , it
-- only makes a half-applied file look like a clean one, which is how 0091
-- applied halfway while reporting success. And `SET LOCAL app.platform_scope`
-- on its own line reports "executed successfully" and has evaporated before
-- the next statement runs.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , CREATE TABLE IF NOT
--    EXISTS, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE
--    POLICY , so the file is safe to re-run from the top after a failure at
--    any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. Nothing
--    below writes a row, so nothing below can be refused by a FORCE ROW LEVEL
--    SECURITY policy , the failure mode 0091 and 0092 both hit. There is
--    nothing to back-fill either: a queue that never drained has no history of
--    successful sends to reconstruct, and inventing one would be inventing
--    evidence that a customer was chased.
--
-- RUN ORDER: after 0096. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started , including how many dunning letters
-- are currently sitting in a queue with no drain.
-- ============================================================================

SELECT
    '0097 · diagnostic'                                        AS finding,
    current_user                                               AS running_as,
    to_regclass('public.tenants')             IS NOT NULL      AS tenants_present,
    to_regclass('public.email_outbox')        IS NOT NULL      AS outbox_already_present,
    to_regclass('public.email_suppressions')  IS NOT NULL      AS suppressions_already_present,
    COALESCE(
        (SELECT count(*) FROM public.credit_dunning_log WHERE delivery = 'queued'),
        0
    )                                                          AS dunning_letters_never_sent;


-- ============================================================================
-- SECTION 2 · `email_outbox` · WHAT IS OWED, AND HOW FAR IT GOT
-- ============================================================================
-- 🔴 `to_email` AND `to_email_normalized` ARE BOTH REAL COLUMNS. The first is
--    the envelope, exactly as the customer supplied it. The second is what the
--    suppression list is matched on. A suppression stored for
--    'bob@example.com' that is looked up as 'Bob@Example.com' is a control
--    that exists, reports success and does nothing , the same shape as the
--    preference switch batch 135 had to fix, one layer down.
--
-- 🔴 `provider_message_id` IS NULLABLE AND IS THE ONLY PROOF OF SEND. The
--    application refuses to write status = 'sent' without one. A CHECK
--    constraint says the same thing in the database, because the rule is worth
--    more than the code that currently honours it.
--
-- ⭐ `claim_token` IS REWRITTEN ON EVERY CLAIM and named in the WHERE clause of
--    every write-back. A worker whose lease expired while it was blocked
--    therefore cannot overwrite state a newer worker has since established.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_outbox (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    purpose               varchar(40)   NOT NULL,
    subject_type          varchar(40),
    subject_id            uuid,

    to_email              varchar(320)  NOT NULL,
    to_email_normalized   varchar(320)  NOT NULL,
    reply_to              varchar(320),

    subject               varchar(300)  NOT NULL,
    body_html             text          NOT NULL,
    body_text             text          NOT NULL,

    category              varchar(40)   NOT NULL,
    severity              varchar(20)   NOT NULL DEFAULT 'info',
    recipient_user_id     uuid          REFERENCES public.users(id) ON DELETE SET NULL,

    idempotency_key       varchar(200)  NOT NULL,

    status                varchar(20)   NOT NULL DEFAULT 'queued',
    provider_message_id   varchar(200),

    attempts              integer       NOT NULL DEFAULT 0,
    max_attempts          integer       NOT NULL DEFAULT 5,
    next_attempt_at       timestamptz   NOT NULL DEFAULT now(),

    claim_token           uuid,
    claimed_at            timestamptz,

    last_error_code       varchar(60),
    last_error_message    varchar(500),

    queued_at             timestamptz   NOT NULL DEFAULT now(),
    sent_at               timestamptz,
    bounced_at            timestamptz,
    dead_at               timestamptz,

    created_by            uuid          REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT email_outbox_status_check
        CHECK (status IN ('queued','sending','sent','bounced','suppressed','dead')),

    -- 🔴 THE RULE THAT MAKES 'sent' MEAN SOMETHING. A row that claims to have
    --    been sent, or to have bounced, must carry the provider's own id. A
    --    collections call that opens with "we have written to you three times"
    --    has to survive the customer's reply.
    CONSTRAINT email_outbox_proof_of_send_check
        CHECK (status NOT IN ('sent','bounced') OR provider_message_id IS NOT NULL)
);

-- 🔴 THE IDEMPOTENCY GUARANTEE, IN THE DATABASE. Two sweeps racing in the same
--    millisecond produce ONE row. A read-then-write check in TypeScript cannot
--    promise that across two containers.
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_idempotency_key
    ON public.email_outbox (tenant_id, idempotency_key);

-- The drain's own query: due work for one tenant, oldest first.
CREATE INDEX IF NOT EXISTS email_outbox_due_idx
    ON public.email_outbox (tenant_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS email_outbox_subject_idx
    ON public.email_outbox (tenant_id, subject_type, subject_id);

-- ⚠️ THE WEBHOOK ARRIVES HOLDING A PROVIDER ID AND NOTHING ELSE , no tenant,
--    no session. Without this index every bounce is a sequential scan of every
--    message this product has ever sent.
CREATE INDEX IF NOT EXISTS email_outbox_provider_idx
    ON public.email_outbox (provider_message_id)
    WHERE provider_message_id IS NOT NULL;


-- ============================================================================
-- SECTION 3 · `email_suppressions` · THE ADDRESSES WE MUST NOT WRITE TO
-- ============================================================================
-- See the header for why `tenant_id` is nullable. In short: a hard bounce
-- belongs to the mailbox, the reputation it damages is shared by every tenant,
-- and NULL means "this applies to everyone".
--
-- ⚠️ RELEASE IS A ROW STATE, NOT A DELETE. "Suppressed for four months, then
--    somebody lifted it" is the first question a deliverability problem forces
--    you to ask, and a deleted row cannot answer it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_suppressions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 🔴 NULLABLE ON PURPOSE. NULL = global. See the file header.
    tenant_id             uuid          REFERENCES public.tenants(id) ON DELETE CASCADE,

    email_normalized      varchar(320)  NOT NULL,

    reason                varchar(30)   NOT NULL,
    detail                varchar(500),
    source                varchar(30)   NOT NULL,
    provider_message_id   varchar(200),

    suppressed_at         timestamptz   NOT NULL DEFAULT now(),

    released_at           timestamptz,
    released_by           uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    release_reason        text,

    CONSTRAINT email_suppressions_reason_check
        CHECK (reason IN ('hard_bounce','complaint','invalid','manual')),

    -- ⚠️ A RELEASE WITHOUT A REASON IS SOMEBODY QUIETLY UNDOING A CONTROL.
    --    The one lift that matters is the one nobody can explain later.
    CONSTRAINT email_suppressions_release_reason_check
        CHECK (released_at IS NULL OR release_reason IS NOT NULL)
);

-- 🔴 `NULLS NOT DISTINCT` IS THE WHOLE POINT OF THIS INDEX AND DRIZZLE CANNOT
--    EXPRESS IT. In PostgreSQL two NULLs are not equal, so without it the
--    GLOBAL suppression for an address could be inserted a second time and the
--    duplicate would quietly succeed where it must be a no-op , which is
--    exactly what a webhook retry does.
--
-- ⚠️ PARTIAL ON `released_at IS NULL`, so an address that was released can be
--    suppressed again later without a conflict against the historic row.
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_active_key
    ON public.email_suppressions (email_normalized, tenant_id) NULLS NOT DISTINCT
    WHERE released_at IS NULL;

-- The dispatcher's question, asked once per message: is this address barred?
CREATE INDEX IF NOT EXISTS email_suppressions_lookup_idx
    ON public.email_suppressions (email_normalized, tenant_id);


-- ============================================================================
-- SECTION 4 · ROW LEVEL SECURITY
-- ============================================================================
-- ⚠️ FORCE MATTERS MORE THAN ENABLE. Plain ENABLE does not apply to the table
--    OWNER, and the application connects as the owner. FORCE exists precisely
--    so the owner is not exempt , without it the isolation would be a comment
--    rather than a control.
-- ============================================================================

-- ---- email_outbox · the ordinary tenant predicate, no escape hatch ---------
-- 🔴 NOBODY , OPERATOR INCLUDED , QUEUES MAIL ON A CUSTOMER'S BEHALF FROM
--    OUTSIDE THAT CUSTOMER'S SESSION. A platform write path here would be a
--    way to send an Ordence-branded message to a customer's customers, which
--    is the precise capability `server/notifications/create.ts` had to be
--    moved out of `server/actions/` to remove.
ALTER TABLE public.email_outbox        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_outbox        FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_outbox_tenant_isolation ON public.email_outbox;
CREATE POLICY email_outbox_tenant_isolation ON public.email_outbox
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- email_suppressions · read the global list, write only your own -------
-- ⚠️ THE READ AND THE WRITE PREDICATES DELIBERATELY DIFFER.
--
--    USING      lets every tenant SEE the global rows, because the dispatcher
--               must be refused by a bounce another workspace discovered.
--
--    WITH CHECK refuses a tenant INSERTING a global row. A tenant that could
--               write `tenant_id = NULL` could silence an address for every
--               other customer of this product , a cross-tenant denial of
--               service costing one INSERT. Global rows are written only under
--               `app.platform_scope`, which is the bounce webhook.
ALTER TABLE public.email_suppressions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions  FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_suppressions_tenant_isolation ON public.email_suppressions;
CREATE POLICY email_suppressions_tenant_isolation ON public.email_suppressions
    USING      (
        tenant_id IS NULL
        OR tenant_id = app_current_tenant_id()
        OR app_platform_scope()
    )
    WITH CHECK (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_platform_scope())
    );


-- ============================================================================
-- SECTION 5 · VERIFICATION · READ ONLY
-- ============================================================================
-- Run this after the sections above. Every column must read TRUE.
-- ============================================================================

SELECT
    '0097 · verification'                                      AS finding,
    to_regclass('public.email_outbox')        IS NOT NULL      AS outbox_created,
    to_regclass('public.email_suppressions')  IS NOT NULL      AS suppressions_created,
    (SELECT relrowsecurity  FROM pg_class WHERE oid = 'public.email_outbox'::regclass)
                                                               AS outbox_rls_enabled,
    (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.email_outbox'::regclass)
                                                               AS outbox_rls_forced,
    (SELECT relrowsecurity  FROM pg_class WHERE oid = 'public.email_suppressions'::regclass)
                                                               AS suppressions_rls_enabled,
    (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.email_suppressions'::regclass)
                                                               AS suppressions_rls_forced,
    EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'email_outbox'
          AND qual LIKE '%app_current_tenant_id%'
    )                                                          AS outbox_policy_present,
    EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'email_suppressions'
          AND qual LIKE '%app_current_tenant_id%'
    )                                                          AS suppressions_policy_present,
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname  = 'email_suppressions_active_key'
    )                                                          AS suppression_unique_present;
