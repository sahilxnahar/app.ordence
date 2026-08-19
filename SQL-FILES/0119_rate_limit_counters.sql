-- ############################################################################
-- 0119 · THE RATE LIMITER, MADE REAL
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.75.0-alpha   ·   Migration number: 0119
--
-- ⚠️ NO `BEGIN`/`COMMIT`. Every statement is independently idempotent.
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY, IN THE LIMITER'S OWN WORDS
-- ############################################################################
--
-- `lib/security/rate-limit.ts` prints this the first time it is used:
--
--     [SECURITY] Rate limiter is running WITHOUT Redis (not_configured).
--     Per-instance memory counters are a speed bump, not a control: on a
--     serverless deployment the effective limit is (limit × instances).
--     Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
--
-- Every word of that is correct, and `UPSTASH_REDIS_REST_URL` is not set. So:
--
--   • the auth limit of 10/minute is 10 × however many instances Railway is
--     running, which is a number nobody controls and nobody knows;
--   • a fresh instance starts with an EMPTY counter, so an attacker who
--     reconnects often enough is never counted at all;
--   • and the warning is `console.warn`, ONCE, on a cold start. Nobody reads
--     it. The product reports itself as rate limited and is not.
--
-- ⚠️ THIS IS THE "DECLARED AND UNENFORCED" PATTERN AGAIN — the same one this
--    codebase has now found sixteen times. The control exists, it is wired
--    into every route, it has policies with rationales, and the number it
--    enforces is unknown.
--
-- ############################################################################
-- ⭐⭐⭐ THE FIX IS THE DATABASE THAT IS ALREADY ON THE REQUEST PATH
-- ############################################################################
--
-- Redis is the right backend and requires a service the operator has not
-- bought. Postgres is already there, already connected, already on every
-- request, and a fixed-window counter is ONE STATEMENT:
--
--     INSERT ... ON CONFLICT (key_hash, window_start) DO UPDATE
--       SET hits = rate_limit_counters.hits + 1
--     RETURNING hits;
--
-- ⭐ THAT IS ATOMIC ACROSS EVERY INSTANCE, which is the entire property the
--    memory counter lacks. One extra round trip on a connection the request
--    already holds.
--
-- ############################################################################
-- 🔴 AND IT STORES A HASH, NOT THE KEY
-- ############################################################################
--
-- A rate-limit key contains an IP address, or a tenant id and a user id. An IP
-- address is personal data — the DPDPA's s.2(t) definition turns on
-- identifiability, and an address plus a timestamp identifies. A table of
-- every IP that has hit the product, with times, is a surveillance log nobody
-- asked for and it would be the single largest personal-data table in the
-- system.
--
-- ⭐ SO THE COLUMN IS `key_hash`: SHA-256 of the namespaced key. Counting is
--    identical on a hash, and the table is worthless to anybody who reads it.
--
-- ⚠️ AND THAT IS NOT THE SAME CLAIM AS "ANONYMOUS". A hash of a known IP is
--    checkable by anybody who guesses the IP — the input space is 2^32. It is
--    a pseudonym, it removes the bulk-disclosure problem, and it is written
--    down here rather than implied.
--
-- ############################################################################

-- ============================================================================
-- ① THE COUNTER
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
    -- 🔴 SHA-256 of the namespaced key, hex. Never the key. See the header.
    key_hash      char(64) NOT NULL,

    -- ⭐ THE FIXED WINDOW'S START, AS AN EPOCH SECOND. Part of the key, so a
    --    new window is a new row rather than an update — which means no read
    --    is needed to decide whether the old count is stale.
    window_start  bigint   NOT NULL,

    -- ⚠️ THE POLICY, FOR PRUNING AND FOR OPERATOR VISIBILITY ONLY. Never for
    --    the decision: the policy is already inside `key_hash` through the
    --    namespace, so two policies cannot collide even if this column were
    --    wrong.
    policy        varchar(20) NOT NULL,
    window_seconds integer  NOT NULL,

    hits          integer  NOT NULL DEFAULT 1,

    -- ⭐ WHEN THIS WINDOW MAY BE DELETED. Computed once, so the sweeper is an
    --    index scan rather than arithmetic over every row.
    expires_at    timestamptz NOT NULL,

    PRIMARY KEY (key_hash, window_start),

    CONSTRAINT rate_limit_counters_hits_positive CHECK (hits > 0),
    CONSTRAINT rate_limit_counters_window_positive CHECK (window_seconds > 0),
    -- ⚠️ A 64-CHARACTER LOWER-CASE HEX DIGEST, ENFORCED. `char(64)` alone
    --    would silently accept a raw key padded to 64 characters, which is
    --    exactly the mistake this table exists to make impossible.
    CONSTRAINT rate_limit_counters_hash_is_a_hash
        CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.rate_limit_counters IS
    'Cross-instance fixed-window rate limit counters. `key_hash` is SHA-256 of '
    'the namespaced key and never the key itself, because a rate-limit key '
    'contains an IP address and a table of every IP that has hit the product '
    'would be the largest personal-data table in the system.';

-- ⭐ THE SWEEPER'S INDEX. Without it the prune is a sequential scan over a
--    table that is, by design, the hottest small table in the database.
CREATE INDEX IF NOT EXISTS rate_limit_counters_expiry_idx
    ON public.rate_limit_counters (expires_at);


-- ============================================================================
-- ② 🔴 NO ROW-LEVEL SECURITY, AND THAT IS A DECISION
-- ============================================================================
--
-- ⚠️ EVERY OTHER TENANT-SHAPED TABLE IN THIS PRODUCT HAS RLS. This one has no
--    tenant column at all, and could not use it:
--
--    • an auth limit is checked BEFORE anybody is authenticated, so there is
--      no tenant to scope to;
--    • a portal limit is checked for a client of a customer, who has no
--      account;
--    • an IP limit exists precisely to count somebody we cannot identify.
--
-- ⭐ WHAT MAKES IT SAFE INSTEAD:
--
--    ① it holds NO tenant data and no personal data — a hash, a count and two
--      timestamps;
--    ② the key namespace already includes the tenant id where one exists, so
--      one workspace cannot consume another's budget;
--    ③ ⭐ AND IT IS DEFINED IN `db/schema/rate-limit.ts` SO NOTHING DEPENDS ON
--      A BAN BEING REMEMBERED. `check:sql-completeness` reports every table
--      that exists in SQL and not in the schema, because `drizzle-kit push`
--      treats those as drift and may DROP them. `push` is forbidden in this
--      project — it drops RLS policies on three hundred tables — and a table
--      whose survival depends on that prohibition being recalled is a table
--      one afternoon away from being gone.
--
--    ⚠️ THE GATE DOES NOT FLAG THE MISSING RLS, because it looks for tables
--      with a `tenant_id` column and this one has none. That is correct
--      behaviour and it is also why this comment exists: the exemption is
--      argued here rather than inferred from a gate's silence.

-- ⚠️ GRANTED TO THE APPLICATION ROLE EXPLICITLY. This table is written on the
--    unauthenticated path, where `app_current_tenant_id()` is null, so nothing
--    else about the request establishes the right to write it.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_counters TO ordence_app;
    END IF;
END
$grant$;


-- ============================================================================
-- ③ ⭐⭐ THE COUNTER FUNCTION — ONE STATEMENT, ATOMIC ACROSS INSTANCES
-- ============================================================================
--
-- ⚠️ A FUNCTION RATHER THAN AN INLINE STATEMENT, so the arithmetic that
--    decides a window boundary exists in exactly one place. An inline version
--    in the application and a different one in a test is how a limiter ends up
--    allowing 11 requests in a 10-request window at the boundary.
--
-- 🔴 `SECURITY DEFINER` WITH A PINNED `search_path`. The application role must
--    be able to count without being granted anything else, and an unpinned
--    search_path on a definer function is the classic privilege-escalation
--    shape — a caller creates `public.now()` in a schema earlier on the path
--    and the function calls theirs.

CREATE OR REPLACE FUNCTION public.ordence_rate_limit_hit(
    p_key_hash       char(64),
    p_policy         varchar(20),
    p_window_seconds integer,
    p_now_epoch      bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_window_start bigint;
    v_hits         integer;
BEGIN
    IF p_window_seconds <= 0 THEN
        RAISE EXCEPTION 'A rate limit window must be a positive number of seconds.';
    END IF;

    -- ⭐ THE FIXED WINDOW. Integer division, so every instance computes the
    --    same boundary from the same clock without coordinating.
    v_window_start := (p_now_epoch / p_window_seconds) * p_window_seconds;

    INSERT INTO public.rate_limit_counters
        (key_hash, window_start, policy, window_seconds, hits, expires_at)
    VALUES
        (p_key_hash, v_window_start, p_policy, p_window_seconds, 1,
         to_timestamp(v_window_start + p_window_seconds * 2))
    ON CONFLICT (key_hash, window_start) DO UPDATE
        SET hits = public.rate_limit_counters.hits + 1
    RETURNING hits INTO v_hits;

    RETURN v_hits;
END
$fn$;

COMMENT ON FUNCTION public.ordence_rate_limit_hit IS
    'Increment and return the hit count for a key within its fixed window. '
    'Atomic across every application instance, which is the entire property '
    'the in-memory fallback lacks.';

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT EXECUTE ON FUNCTION public.ordence_rate_limit_hit TO ordence_app;
    END IF;
END
$grant$;


-- ============================================================================
-- ④ THE SWEEPER
-- ============================================================================
--
-- ⚠️ WINDOWS ARE KEPT FOR TWO WINDOWS, NOT ONE. A row deleted the instant its
--    window ends is a row that vanishes while a request that started inside
--    that window is still deciding, and the decision then reads zero.
--
-- ⭐ AND IT IS BOUNDED. A `DELETE` with no limit on a hot table takes a lock
--    long enough to be noticed on every request in flight. Ten thousand rows
--    is a few milliseconds and is called on a schedule.

CREATE OR REPLACE FUNCTION public.ordence_rate_limit_sweep(p_limit integer DEFAULT 10000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_deleted integer;
BEGIN
    WITH doomed AS (
        SELECT key_hash, window_start
          FROM public.rate_limit_counters
         WHERE expires_at < now()
         LIMIT p_limit
    )
    DELETE FROM public.rate_limit_counters c
     USING doomed d
     WHERE c.key_hash = d.key_hash AND c.window_start = d.window_start;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END
$fn$;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT EXECUTE ON FUNCTION public.ordence_rate_limit_sweep TO ordence_app;
    END IF;
END
$grant$;


-- ============================================================================
-- ⑤ THE VERDICT
-- ============================================================================

SELECT
    'SQL 0119 · The rate limiter, made real'                                AS migration,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'rate_limit_counters')  AS table_expect_1,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('ordence_rate_limit_hit', 'ordence_rate_limit_sweep')) AS functions_expect_2,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('ordence_rate_limit_hit', 'ordence_rate_limit_sweep')
        AND p.prosecdef
        AND array_to_string(p.proconfig, ',') LIKE '%search_path%')           AS pinned_definers_expect_2,
    -- 🔴 READ THIS ONE. Zero means the limiter has never counted anything in
    --    this database, which after a deploy means the application is still on
    --    the in-memory fallback and the limit is (limit x instances).
    (SELECT count(*) FROM public.rate_limit_counters)                        AS windows_counted_so_far;
