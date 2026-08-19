-- ############################################################################
-- 0114 · A SEAT LIMIT THAT ACTUALLY REFUSES, AND THE TWO PEOPLE WHO CAN
--        OVERRIDE IT
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.70.0-alpha   ·   Migration number: 0114
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY, PRECISELY
-- ############################################################################
--
-- `lib/billing/seats.ts` is a careful piece of work. It decides what counts as
-- a seat explicitly, it refuses to auto-charge for an overage, and it refuses
-- to pick which six of eleven employees to lock out. All of that is right.
--
-- ⚠️ AND THE LIMIT IS ADVISORY, because of where users actually come from.
--
-- There is NO in-product invite. People are added in Clerk's own dashboard or
-- by SSO auto-provision, so `app/api/webhooks/clerk/_webhook.ts` is the only
-- door. That path checks the seat limit, writes a high-severity audit row, and
-- CREATES THE USER ANYWAY. Its own comment gives the reason:
--
--     "Returning a non-2xx here would make Clerk retry the membership event
--      indefinitely, and the person would exist in the identity provider while
--      never existing in the product — able to sign in, and then landing on a
--      broken workspace with no explanation and no way for their admin to find
--      out why."
--
-- ⭐ THAT IS ENTIRELY CORRECT ABOUT REFUSING, AND IT IS NOT A REASON TO ADMIT
--    THEM. There is a third state neither the code nor the comment considers:
--    create the person, give Clerk its 200, and DO NOT GIVE THEM A SEAT.
--
-- ############################################################################
-- ⭐⭐⭐ THE DESIGN: `pending_seat` IS A STATUS, NOT A FLAG
-- ############################################################################
--
-- `occupiesSeat()` in `lib/billing/seats.ts` is the single predicate every
-- other calculation depends on, and it reads `status`. Adding a boolean beside
-- the status would give two sources of truth for one question, and the one that
-- disagrees is the one billing quotes.
--
-- 🔴 `pending_seat` DOES NOT CONSUME A SEAT. That is the whole point: a
--    workspace at 10 of 10 can have three people parked and still be at 10 of
--    10, so the owner is asked to buy three seats rather than discovering they
--    are at 13.
--
-- ⚠️ AND IT IS NOT `suspended`. Suspension means somebody was in and was taken
--    out; this means they were never let in. Six months later, "why was Priya
--    suspended in March" and "Priya waited eleven days for a seat" are
--    different facts, and only one of them is a story about your onboarding.
--
-- ############################################################################
-- ⭐⭐ AND A GRANT ADDS CAPACITY, IT DOES NOT CONSUME IT
-- ############################################################################
--
-- Two people can let a parked person in:
--
--   THE WORKSPACE OWNER, by buying a seat. Ordinary commerce. Nothing here.
--
--   ORDENCE, by granting one. A goodwill seat, a migration in progress, an
--   enterprise deal signed and not yet billed. `seat_grants` records it.
--
-- 🔴 A GRANT RAISES THE LIMIT; IT DOES NOT FILL A SEAT. `effective seats =
--    seats_purchased + Σ active grants`. Modelling it the other way — marking
--    a user as "granted" and skipping them in the count — would mean the seat
--    disappears when that person leaves, and the customer silently loses a
--    concession somebody deliberately made.
--
-- ⚠️ EVERY GRANT NEEDS A REASON OF AT LEAST TEN CHARACTERS, and a CHECK
--    enforces it. This codebase already holds that line in four places — the
--    DPDPA verification note in `0113`, the not-claimable reason in `0110`, the
--    GSTR-2B decision reason, the erasure refusal. A free seat with no reason
--    is indistinguishable from a mistake in the billing table, and it is found
--    by an accountant asking why revenue per workspace does not foot.
--
-- ############################################################################
-- SAFE TO RUN TWICE. No BEGIN, no COMMIT, no bare SET LOCAL: the Neon browser
-- console sends each statement on its own connection.
--
-- ⚠️ `ALTER TYPE ... ADD VALUE` CANNOT BE USED IN THE SAME TRANSACTION THAT
--    ADDS IT. Because the console gives every statement its own connection and
--    therefore its own transaction, section ① commits before anything reads the
--    new value. If you ever run this file through `psql -f` inside an explicit
--    transaction, that is the statement that will fail, and it will fail
--    loudly rather than silently.
-- ############################################################################


-- ============================================================================
-- ① THE STATUS
-- ============================================================================

ALTER TYPE public.user_status ADD VALUE IF NOT EXISTS 'pending_seat';

COMMENT ON TYPE public.user_status IS
    'invited and active hold a seat. suspended, offboarded and pending_seat do '
    'not. pending_seat means the person exists because the identity provider '
    'created them, and the workspace had no seat free — they can sign in and '
    'see one screen explaining that, and nothing else.';


-- ============================================================================
-- ② `seat_grants` · CAPACITY SOMEBODY GAVE, WITH THEIR NAME ON IT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.seat_grants (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- ⚠️ A COUNT, NOT A USER. A grant is capacity, so it survives the person
    --    who prompted it leaving. See the header.
    seats              integer NOT NULL,

    -- 🔴 WHO GAVE IT. `platform` means Ordence; `owner` means the workspace
    --    bought or freed capacity itself and this row is the audit of the
    --    decision rather than the mechanism.
    granted_by_kind    varchar(16) NOT NULL DEFAULT 'platform',
    granted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

    -- 🔴 TEN CHARACTERS. See the header: a free seat with no reason is
    --    indistinguishable from a mistake in the billing table.
    reason             text NOT NULL,

    granted_at         timestamptz NOT NULL DEFAULT now(),

    -- ⚠️ NULL MEANS PERMANENT, and that is the honest default. A grant with a
    --    date on it is a decision to revisit; a grant without one is a
    --    decision that was made. Guessing an expiry would silently withdraw
    --    capacity a customer is relying on.
    expires_at         timestamptz,

    revoked_at         timestamptz,
    revoked_reason     text,

    CONSTRAINT seat_grants_seats_positive
        CHECK (seats > 0),

    CONSTRAINT seat_grants_reason_is_a_reason
        CHECK (length(btrim(reason)) >= 10),

    CONSTRAINT seat_grants_kind_known
        CHECK (granted_by_kind IN ('platform', 'owner')),

    -- ⚠️ REVOKING IS ALSO A DECISION. Taking capacity back with no reason
    --    reads, three months later, as a bug in the billing table.
    CONSTRAINT seat_grants_revocation_needs_reason
        CHECK (revoked_at IS NULL OR length(btrim(coalesce(revoked_reason, ''))) >= 10),

    CONSTRAINT seat_grants_expiry_after_grant
        CHECK (expires_at IS NULL OR expires_at > granted_at)
);

COMMENT ON TABLE public.seat_grants IS
    'Seat capacity granted outside the subscription. Effective seats = '
    'subscriptions.seats_purchased + the sum of seats on grants that are '
    'neither revoked nor expired. A grant RAISES the limit rather than filling '
    'a seat, so it survives the person who prompted it leaving.';

CREATE INDEX IF NOT EXISTS seat_grants_active_idx
    ON public.seat_grants (tenant_id)
 WHERE revoked_at IS NULL;

ALTER TABLE public.seat_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seat_grants_tenant_isolation ON public.seat_grants;
CREATE POLICY seat_grants_tenant_isolation
    ON public.seat_grants
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ③ `seat_requests` · THE QUEUE, AND IT IS PER PERSON
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.seat_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES public.users(id)   ON DELETE CASCADE,

    -- ⚠️ WHERE THEY CAME FROM, because the two need different handling and
    --    the difference is invisible afterwards. `identity_provider` means
    --    Clerk created them and we parked them; `invite` means somebody in the
    --    product tried and was refused at the moment they tried.
    source         varchar(24) NOT NULL,

    requested_at   timestamptz NOT NULL DEFAULT now(),

    -- 🔴 THE SEAT POSITION AT THE MOMENT IT HAPPENED, frozen. Reading it back
    --    from today's numbers would answer a different question: "were they
    --    over the limit now", not "were they over the limit then". The second
    --    is the one that explains why this row exists.
    seats_used_at_request      integer NOT NULL,
    seats_available_at_request integer NOT NULL,

    resolved_at    timestamptz,
    resolution     varchar(24),
    resolved_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    resolution_reason text,

    CONSTRAINT seat_requests_source_known
        CHECK (source IN ('identity_provider', 'invite', 'reactivation')),

    CONSTRAINT seat_requests_resolution_known
        CHECK (resolution IS NULL
               OR resolution IN ('approved', 'declined', 'seat_freed', 'withdrawn')),

    -- ⚠️ A RESOLUTION AND A TIME TRAVEL TOGETHER. One without the other is a
    --    half-recorded decision, and the half that is missing is always the
    --    one somebody needs.
    CONSTRAINT seat_requests_resolution_pair
        CHECK ((resolved_at IS NULL) = (resolution IS NULL)),

    -- 🔴 DECLINING SOMEBODY NEEDS A REASON. Approving does not: the seat count
    --    already explains an approval, and nothing explains a refusal. Same
    --    asymmetry as the GSTR-2B worklist, and for the same reason — three
    --    months later "why was this person never let in" has no answer.
    CONSTRAINT seat_requests_decline_needs_reason
        CHECK (resolution IS DISTINCT FROM 'declined'
               OR length(btrim(coalesce(resolution_reason, ''))) >= 10),

    CONSTRAINT seat_requests_counts_not_negative
        CHECK (seats_used_at_request >= 0 AND seats_available_at_request >= 0)
);

COMMENT ON TABLE public.seat_requests IS
    'One row per person who could not be given a seat when they arrived. The '
    'seat position is frozen at request time because reading it back from '
    'today would answer a different question. A declined request needs a '
    'reason; an approved one does not, because the seat count explains it.';

-- 🔴 ONE OPEN REQUEST PER PERSON. Without this, a Clerk membership event
--    replayed — which Clerk does, on purpose, and which this codebase has
--    already been bitten by — would queue the same person twice and an owner
--    would approve a seat for somebody who already has one.
CREATE UNIQUE INDEX IF NOT EXISTS seat_requests_one_open_per_user
    ON public.seat_requests (tenant_id, user_id)
 WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS seat_requests_open_idx
    ON public.seat_requests (tenant_id, requested_at)
 WHERE resolved_at IS NULL;

ALTER TABLE public.seat_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seat_requests_tenant_isolation ON public.seat_requests;
CREATE POLICY seat_requests_tenant_isolation
    ON public.seat_requests
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ④ 🔴 THE GUARD · A DECISION THAT HAS BEEN MADE DOES NOT UNMAKE ITSELF
-- ============================================================================
--
-- ⚠️ SAME TECHNIQUE AS `ordence_guard_posted_itc_deferral` IN 0112, and for
--    the same reason: the application already refuses this in words, and a
--    server action is not a constraint.

CREATE OR REPLACE FUNCTION public.ordence_guard_resolved_seat_request()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
    IF OLD.resolved_at IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.resolution   IS DISTINCT FROM OLD.resolution
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    THEN
        RAISE EXCEPTION
            'This seat request was resolved as % on %. Reopening it would erase who decided and when. If the decision was wrong, the person is added or removed through the team screen and that act is recorded on its own.',
            OLD.resolution, OLD.resolved_at
            USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS ordence_guard_resolved_seat_request ON public.seat_requests;

CREATE TRIGGER ordence_guard_resolved_seat_request
    BEFORE UPDATE ON public.seat_requests
    FOR EACH ROW EXECUTE FUNCTION public.ordence_guard_resolved_seat_request();


-- ============================================================================
-- ⑤ THE VERDICT
-- ============================================================================
--
-- ⚠️ ONE STATEMENT, SINGLE-QUOTED LITERAL. A dollar-quoted literal in a
--    verdict SELECT was mangled once in 0101, and the result was the worst
--    available: every earlier statement applied and the one row that would
--    have told you so was a syntax error.

SELECT
    'SQL 0114 · seat grants and pending seats'                          AS migration,
    (SELECT count(*) FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'user_status' AND e.enumlabel = 'pending_seat') AS status_added_expect_1,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('seat_grants', 'seat_requests'))             AS tables_expect_2,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('seat_grants', 'seat_requests'))              AS policies_expect_2,
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'ordence_guard_resolved_seat_request')             AS guard_expect_1,
    (SELECT count(*) FROM public.users WHERE status = 'pending_seat')   AS people_waiting_for_a_seat;
