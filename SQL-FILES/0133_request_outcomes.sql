-- ############################################################################
-- 0133 · THE DENOMINATOR — WITHOUT IT THERE IS NO AVAILABILITY NUMBER
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.81.0-alpha   ·   Migration number: 0133
-- Wave 14 · Track B (observability, SLOs and the evidence layer)
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY
-- ############################################################################
--
-- This product records failures in three places and successes in none.
--
--   error_events       every server exception, since 0011
--   security_events    every refusal worth alarming about, since 0012
--   web_vital_events   client-side timing, but ONLY on page loads that
--                      completed, from browsers that ran the reporter
--
-- ⚠️ SO THE QUESTION "WHAT FRACTION OF REQUESTS SUCCEEDED" HAS NO ANSWER
--    HERE, AND IT CANNOT BE DERIVED. An error count without a request count
--    is not an error rate. Two hundred errors is an outage on a quiet
--    Sunday and background noise on a Monday, and nothing in the database
--    can tell those apart.
--
-- ⭐ AND IT IS WORSE THAN "NO NUMBER", BECAUSE THE MISSING DENOMINATOR
--    DEFAULTS TO GREEN. A dashboard built on error_events alone shows a flat
--    line the morning the request path stops running entirely — no requests,
--    no errors, no alert. That is this repository's characteristic defect
--    (verified by a floor, green because empty) applied to its own health.
--
-- ⭐ THIS TABLE IS THE DENOMINATOR. One row per (workspace, route, outcome)
--    per MINUTE, holding a count and a latency histogram.
--
-- ############################################################################
-- ⚠️ WHY A ROLLUP AND NOT ONE ROW PER REQUEST
-- ############################################################################
--
-- One row per request would be an access log, and an access log in this
-- database is three bad things at once: it is the highest-volume table in the
-- product by an order of magnitude, it is a second copy of who did what (which
-- audit_logs already holds, with a hash chain and an RLS policy written for
-- it), and on Neon it is a storage bill that grows with traffic rather than
-- with customers.
--
-- The rollup is bounded by (workspaces × routes × outcomes × 1440) per day and
-- carries no identity at all — no user, no ip, no record id. You cannot ask it
-- who; you can only ask it how many and how fast, which are the two questions
-- an SLO is made of.
--
-- ⚠️ THE COST IT DOES ADD, STATED PLAINLY: one extra UPSERT on the request
--    path. `server/observability/request-observer.ts` issues it in the SAME
--    transaction as the api_calls metering write that has to happen anyway, so
--    it is one more statement rather than one more round trip, and it is
--    best-effort — see that file's contract, which is the one
--    `server/metering/record.ts` established: a recorder that can throw turns
--    a database hiccup into a 500 on the busiest customer first.
--
-- ############################################################################
-- ⚠️ THE HISTOGRAM IS CUMULATIVE, AND THE CHECK CONSTRAINTS ENFORCE IT
-- ############################################################################
--
-- `le_250` counts observations at or below 250 ms, so it INCLUDES everything
-- `le_100` counted. That is the Prometheus convention and it makes p95 a
-- linear scan rather than a join.
--
-- 🔴 AND IT IS THE ONE THING A BROKEN WRITER GETS WRONG SILENTLY. A writer
--    that increments only its own bucket produces a histogram that is not
--    monotonic; every percentile read off it is then wrong, plausibly, and
--    forever. `request_outcomes_histogram_monotonic` below refuses the row
--    instead. This is deliberately a CHECK and not a comment: the whole point
--    of this wave is that a rule which is written down and not enforced is a
--    rule that has already been broken somewhere.
--
-- ############################################################################
-- IS THERE DATA LOSS?  No. This file only creates. `prune_request_outcomes()`
-- is created but NOT called, exactly as 0128 did for change_log.
--
-- RUN ORDER: after 0011 (which defines app_current_tenant_id and
-- app_platform_scope). SQL FIRST, then the code — the writer is new in the
-- same wave and degrades to a no-op if the table is absent.
--
-- ⚠️ NO BEGIN/COMMIT. The Neon console sends every statement on its own
--    connection, so a BEGIN opens a transaction that is rolled back the
--    moment the statement returns and everything after it runs outside it.
--    A migration that LOOKS atomic and is not is worse than one that plainly
--    is not.
-- ############################################################################


-- ============================================================================
-- ① THE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.request_outcomes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ⚠️ NULLABLE, AND ON DELETE CASCADE. Nullable because an unauthenticated
    -- request genuinely has no workspace and those rows are the ones that
    -- matter most when sign-in itself is the outage. CASCADE because this is
    -- derived operational data with no evidential value — unlike audit_logs,
    -- which is RESTRICT precisely so a workspace cannot be deleted to erase
    -- its own record.
    tenant_id         uuid REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- A PATTERN from scrubUrl(), never a URL. Enforced below.
    route_pattern     varchar(200) NOT NULL,

    -- 'http' or 'job'. Separated because a cron failing for every workspace
    -- and a page failing for every user are one number and two incidents.
    kind              varchar(8)   NOT NULL DEFAULT 'http',

    -- The closed vocabulary from lib/telemetry/log.ts. Free text here would
    -- be three spellings of success and no availability number.
    outcome           varchar(12)  NOT NULL,

    -- Truncated to the minute. The CHECK below makes that structural rather
    -- than a convention the next writer has to remember.
    bucket_start      timestamptz  NOT NULL,

    observations      bigint       NOT NULL DEFAULT 0,
    duration_ms_sum   bigint       NOT NULL DEFAULT 0,
    duration_ms_max   integer      NOT NULL DEFAULT 0,

    -- Cumulative histogram. le_N = observations at or below N milliseconds.
    le_100            bigint       NOT NULL DEFAULT 0,
    le_250            bigint       NOT NULL DEFAULT 0,
    le_500            bigint       NOT NULL DEFAULT 0,
    le_1000           bigint       NOT NULL DEFAULT 0,
    le_2000           bigint       NOT NULL DEFAULT 0,
    le_5000           bigint       NOT NULL DEFAULT 0,

    first_seen_at     timestamptz  NOT NULL DEFAULT now(),
    last_seen_at      timestamptz  NOT NULL DEFAULT now()
);

-- ⚠️ `NULLS NOT DISTINCT` IS LOAD-BEARING AND IS POSTGRES 15+.
-- Under the default (NULLS DISTINCT) every unauthenticated observation would
-- insert a NEW row rather than incrementing one, because NULL <> NULL — so the
-- null-tenant rows, the ones that matter during an auth outage, would be the
-- only ones that never aggregate. Neon runs 16.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'request_outcomes_bucket_unique'
           AND conrelid = 'public.request_outcomes'::regclass
    ) THEN
        ALTER TABLE public.request_outcomes
            ADD CONSTRAINT request_outcomes_bucket_unique
            UNIQUE NULLS NOT DISTINCT (tenant_id, route_pattern, kind, outcome, bucket_start);
    END IF;
END
$$;


-- ============================================================================
-- ② THE CONSTRAINTS THAT MAKE A WRONG NUMBER IMPOSSIBLE RATHER THAN UNLIKELY
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_outcome_known') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_outcome_known
            CHECK (outcome IN ('ok','denied','invalid','failed','throttled','skipped'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_kind_known') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_kind_known
            CHECK (kind IN ('http','job'));
    END IF;

    -- 🔴 A raw URL here would put record ids and search terms — which in a CRM
    -- are customer names — into a table nobody thinks of as personal data.
    -- Same three tests as error_events_route_is_pattern, deliberately.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_route_is_pattern') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_route_is_pattern
            CHECK (route_pattern NOT LIKE '%?%'
               AND route_pattern NOT LIKE '%://%'
               AND route_pattern LIKE '/%');
    END IF;

    -- The bucket is aligned by the DATABASE, not by whoever wrote the client.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_bucket_aligned') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_bucket_aligned
            CHECK (bucket_start = date_trunc('minute', bucket_start));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_counts_sane') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_counts_sane
            CHECK (observations    >= 0
               AND duration_ms_sum >= 0
               AND duration_ms_max >= 0
               AND le_100 >= 0);
    END IF;

    -- 🔴 THE ONE THAT CATCHES A BROKEN WRITER. See the header.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_outcomes_histogram_monotonic') THEN
        ALTER TABLE public.request_outcomes ADD CONSTRAINT request_outcomes_histogram_monotonic
            CHECK (le_100  <= le_250
               AND le_250  <= le_500
               AND le_500  <= le_1000
               AND le_1000 <= le_2000
               AND le_2000 <= le_5000
               AND le_5000 <= observations);
    END IF;
END
$$;


-- ============================================================================
-- ③ INDEXES
-- ============================================================================
--
-- ⚠️ EVERY READ OF THIS TABLE IS "A WINDOW", so bucket_start is in every one.
-- The three below are the three questions the status surface asks and no more:
-- a table with an index per column is a table whose writes cost more than its
-- reads save, and this one is written on every request.

CREATE INDEX IF NOT EXISTS request_outcomes_tenant_bucket_idx
    ON public.request_outcomes (tenant_id, bucket_start DESC);

CREATE INDEX IF NOT EXISTS request_outcomes_bucket_idx
    ON public.request_outcomes (bucket_start DESC);

CREATE INDEX IF NOT EXISTS request_outcomes_route_bucket_idx
    ON public.request_outcomes (route_pattern, bucket_start DESC);


-- ============================================================================
-- ④ ROW-LEVEL SECURITY
-- ============================================================================
--
-- 🔴 FORCE, NOT MERELY ENABLE. Production connects as `neondb_owner`, which
--    OWNS these tables, and a table owner is not subject to plain ENABLE. A
--    policy without FORCE is a policy that applies to nobody who matters.
--
-- ⭐ THE READ BRANCH INCLUDES app_platform_scope() AND THE WRITE BRANCH DOES
--    NOT — except for global rows. That asymmetry is deliberate and it is the
--    idiom `scripts/check-rls-coverage.mjs` recognises as `isGlobalWriteOnly`:
--
--      READ   any workspace's own rows; every workspace's rows under platform
--             scope, because the status surface is a cross-tenant view and a
--             per-tenant health board that cannot see across tenants is the
--             global average this whole track exists to replace.
--      WRITE  a workspace's own rows ONLY in that workspace's own scope. The
--             single exception is `tenant_id IS NULL`, which is a GLOBAL row
--             (an unauthenticated request) and not another tenant's row.
--
-- ⚠️ error_events (0011) put app_platform_scope() in its WITH CHECK too. This
--    file does NOT copy that, and the difference is the point: a platform-scope
--    write branch means any platform-scoped code path can attribute a row to
--    any workspace. For a diagnostics table written from an error handler that
--    was a defensible trade; for a table an availability number is computed
--    from, a mis-attributed row is a wrong number about somebody else's
--    service, so the writer is made to enter the workspace properly instead.

ALTER TABLE public.request_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_outcomes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS request_outcomes_tenant_isolation ON public.request_outcomes;
CREATE POLICY request_outcomes_tenant_isolation
    ON public.request_outcomes
    USING (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
        OR app_platform_scope()
    )
    WITH CHECK (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_platform_scope())
    );


-- ============================================================================
-- ⑤ GRANTS
-- ============================================================================
--
-- ⚠️ REVOKE FIRST. A GRANT block that only ever ADDS is worthless as a
--    restriction: if anybody has ever run `GRANT ALL ON ALL TABLES IN SCHEMA
--    public`, the app already holds DELETE and every GRANT below is a no-op.
--    0011 records the same reasoning for the same reason.
--
-- ⚠️ NO DELETE. Retention is `prune_request_outcomes()` below, which the
--    application cannot execute. An application that can delete its own
--    availability history can delete the evidence of its own outage.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        REVOKE ALL ON public.request_outcomes FROM ordence_app;
        GRANT SELECT, INSERT, UPDATE ON public.request_outcomes TO ordence_app;
    END IF;
END
$$;


-- ============================================================================
-- ⑥ RETENTION — CREATED, NOT RUN
-- ============================================================================
--
-- ⚠️ THE 7-DAY FLOOR IS LOWER THAN change_log's 30 AND THAT IS NOT AN
--    OVERSIGHT. change_log holds edits that can never be reconstructed; this
--    holds counters that are meaningless once the window they describe has
--    passed. But 7 rather than 1, because every SLO here has a 30-day window
--    and a prune that can be asked for "yesterday" is a prune that can delete
--    the month the argument is about.

DROP FUNCTION IF EXISTS public.prune_request_outcomes(integer, boolean);

CREATE OR REPLACE FUNCTION public.prune_request_outcomes(
    older_than_days integer DEFAULT 90,
    dry_run         boolean DEFAULT true
)
RETURNS TABLE (rows_affected bigint, oldest_kept timestamptz, was_dry_run boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
    cutoff  timestamptz;
    removed bigint := 0;
BEGIN
    IF older_than_days < 7 THEN
        RAISE EXCEPTION
            'Refusing to prune request_outcomes younger than 7 days (asked for %). Every SLO in docs/SLOS.md has a 30-day window; a shorter prune deletes the evidence for the number being disputed.',
            older_than_days
            USING ERRCODE = '22023';
    END IF;

    cutoff := date_trunc('minute', now() - make_interval(days => older_than_days));

    -- ⚠️ PLATFORM SCOPE IS SET INSIDE THE FUNCTION, NOT ASSUMED.
    -- This table has FORCE RLS. `neondb_owner` is NOT a superuser and has NO
    -- bypassrls, so without this the DELETE matches ZERO ROWS and the function
    -- reports success having removed nothing — the exact failure 0128 hit and
    -- wrote up. Unlike change_log, this table's policy HAS a platform branch
    -- in USING, so one statement suffices and no tenant loop is needed.
    PERFORM set_config('app.platform_scope', 'on', true);

    IF dry_run THEN
        SELECT count(*) INTO removed FROM request_outcomes WHERE bucket_start < cutoff;
    ELSE
        DELETE FROM request_outcomes WHERE bucket_start < cutoff;
        GET DIAGNOSTICS removed = ROW_COUNT;
    END IF;

    RETURN QUERY SELECT removed, cutoff, dry_run;
END
$fn$;

COMMENT ON FUNCTION public.prune_request_outcomes(integer, boolean) IS
    'Bounds the request_outcomes window. 90-day default, dry_run = true by default, refuses under 7 days. Not callable by the application role: a service that can delete its own availability history can delete the evidence of its own outage.';

DO $$
BEGIN
    REVOKE ALL ON FUNCTION public.prune_request_outcomes(integer, boolean) FROM PUBLIC;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        REVOKE ALL ON FUNCTION public.prune_request_outcomes(integer, boolean) FROM ordence_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
        GRANT EXECUTE ON FUNCTION public.prune_request_outcomes(integer, boolean) TO ordence_maintenance;
    END IF;
END
$$;



-- ============================================================================
-- ⑦ THE CROSS-CUTTING SWEEPS — CALLED, NOT ASSUMED
-- ============================================================================
--
-- 🔴 THIS SECTION EXISTS BECAUSE `npm run test:security` FAILED WITHOUT IT.
--
--     tests/security/wave13-coverage.test.ts
--     › every tenant-scoped table refuses DELETE under impersonation
--     AssertionError: a support engineer inside an impersonation session can
--     DELETE from these tables: expected [ 'observability_alerts', … ]
--
-- Wave 13 built three registry sweeps precisely so a module migration can
-- call them and a new table cannot silently miss a cross-cutting control.
-- The test asserts ZERO gaps, not a threshold — its own header records that
-- the previous check printed PASS while the guard covered 48 of 303 tables.
--
-- ⭐ SO THIS FILE CALLS THEM. A table added without calling them is a table
--    an impersonating support engineer can delete rows from.

-- ----------------------------------------------------------------------------
-- ⑦.1 🔴 request_outcomes IS EXCLUDED FROM change_log, AND THIS IS A REAL
--         DECISION WITH A REAL COST
-- ----------------------------------------------------------------------------
--
-- `change_log` records every INSERT, UPDATE and DELETE on every tenant table,
-- with full `old_row` and `new_row` JSONB snapshots. `request_outcomes` is
-- written ON EVERY REQUEST — it is by construction the highest-write table in
-- this product.
--
-- ⚠️ ATTACHING THE RECORDER TO IT WOULD ROUGHLY QUADRUPLE ITS COST: one
--    UPSERT becomes an UPSERT plus a change row carrying two copies of the
--    counter row. 0128 already exists because change_log is "the
--    fastest-growing table in this product"; this would make it grow with
--    traffic rather than with edits.
--
-- ⚠️ AND THERE IS NOTHING TO RECONSTRUCT. change_log's purpose (0017) is to
--    let a future sync client replay history it did not see. A counter that
--    is derived, prunable and meaningless outside its own minute has no
--    history worth replaying — the same argument `error_events` and
--    `security_events` are already excluded on.
--
-- ⭐ THE COST, STATED: an UPDATE to a request_outcomes row leaves no trace.
--    Nothing in the application can perform one except the upsert above, and
--    the application holds no DELETE at all.

INSERT INTO public.change_log_exclusions (table_name, reason, category, declared_in)
VALUES (
  'request_outcomes',
  'Derived per-minute counters written on every request. Attaching the change recorder would roughly quadruple the cost of the highest-write table in the product, to record a history that is prunable, derived and meaningless outside its own minute. Same reasoning as error_events and security_events.',
  -- ⚠️ 'derived', AND THE VALUE IS CHECKED. `change_log_exclusions_category_check`
  -- permits exactly self | append-only | derived | platform. The first draft
  -- wrote 'telemetry', which is a perfectly sensible word and is refused —
  -- caught only by executing this file against a real PostgreSQL, because a
  -- CHECK constraint on a registry table is invisible from the schema.
  'derived',
  '0133_request_outcomes.sql'
)
ON CONFLICT (table_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- ⑦.2 THE IMPERSONATION DELETE GUARD
-- ----------------------------------------------------------------------------
--
-- ⚠️ IT MATTERS EVEN THOUGH THE APPLICATION HOLDS NO DELETE ON THIS TABLE.
--    The GRANT is one migration away from being widened, and the guard is
--    what makes "a support engineer wearing a customer's face cannot destroy
--    evidence" a property of the database rather than of a GRANT block.

SELECT * FROM public.attach_impersonation_guards();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.request_outcomes'::regclass
           AND tgname  = 'no_delete_under_impersonation'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            '0133 FAILED: request_outcomes has no no_delete_under_impersonation trigger. attach_impersonation_guards() ran and did not attach it, which means the sweep no longer sees new tables.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.change_log_exclusions WHERE table_name = 'request_outcomes') THEN
        RAISE EXCEPTION
            '0133 FAILED: request_outcomes is not in change_log_exclusions, so the next attach_change_log_triggers() sweep will quadruple the write cost of the busiest table in the product.';
    END IF;

    RAISE NOTICE '0133 SWEEPS PASS: impersonation delete guard attached; change_log recorder deliberately not attached, with a reason on the row.';
END
$$;

-- ============================================================================
-- ⑧ VERIFY — AND RAISE IF THE CHANGE DID NOT TAKE
-- ============================================================================
--
-- ⚠️ THIS BLOCK RAISES. A migration that can succeed while doing nothing is
--    the same bug as a coverage check written `count(*) >= 10`.

DO $$
DECLARE
    n_checks   integer;
    forced     boolean;
    n_policy   integer;
    n_index    integer;
    app_delete boolean;
BEGIN
    IF to_regclass('public.request_outcomes') IS NULL THEN
        RAISE EXCEPTION '0133 FAILED: request_outcomes was not created.';
    END IF;

    SELECT count(*) INTO n_checks FROM pg_constraint
     WHERE conrelid = 'public.request_outcomes'::regclass AND contype = 'c';
    IF n_checks < 6 THEN
        RAISE EXCEPTION '0133 FAILED: expected 6 CHECK constraints on request_outcomes, found %.', n_checks;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'request_outcomes_bucket_unique'
                      AND conrelid = 'public.request_outcomes'::regclass) THEN
        RAISE EXCEPTION '0133 FAILED: the NULLS NOT DISTINCT unique key is missing, so null-tenant observations would never aggregate.';
    END IF;

    SELECT relforcerowsecurity INTO forced FROM pg_class
     WHERE oid = 'public.request_outcomes'::regclass;
    IF forced IS NOT TRUE THEN
        RAISE EXCEPTION '0133 FAILED: FORCE ROW LEVEL SECURITY is off. Production connects as the table owner, so ENABLE alone applies to nobody.'
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*) INTO n_policy FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'request_outcomes';
    IF n_policy < 1 THEN
        RAISE EXCEPTION '0133 FAILED: RLS is forced with no policy, which denies every row to everybody.'
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*) INTO n_index FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'request_outcomes';
    IF n_index < 4 THEN
        RAISE EXCEPTION '0133 FAILED: expected 4 indexes (primary key, unique, and 3 read paths), found %.', n_index;
    END IF;

    IF to_regprocedure('public.prune_request_outcomes(integer, boolean)') IS NULL THEN
        RAISE EXCEPTION '0133 FAILED: prune_request_outcomes() was not created, so this table has no retention policy.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
          JOIN pg_roles r ON r.oid = a.grantee
         WHERE p.proname = 'prune_request_outcomes'
           AND r.rolname = 'ordence_app'
           AND a.privilege_type = 'EXECUTE'
    ) INTO app_delete;
    IF app_delete THEN
        RAISE EXCEPTION '0133 FAILED: the application role can execute prune_request_outcomes(), which hands back the DELETE this file withheld.'
            USING ERRCODE = '42501';
    END IF;

    RAISE NOTICE '0133 PASS: request_outcomes exists with % CHECKs, % policy, % indexes, FORCE RLS on, and a retention function the application cannot call. NOTHING HAS BEEN DELETED.',
        n_checks, n_policy, n_index;
END
$$;

-- ⚠️ ONE STATEMENT, SINGLE-QUOTED LITERALS, for the Neon console.
SELECT
    'SQL 0133 · request_outcomes'                                              AS migration,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'request_outcomes')       AS table_expect_1,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'request_outcomes')          AS policy_expect_1,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.request_outcomes'::regclass AND contype = 'c')  AS checks_expect_6,
    (SELECT relforcerowsecurity FROM pg_class
      WHERE oid = 'public.request_outcomes'::regclass)                         AS force_rls_expect_true,
    (SELECT count(*) FROM pg_proc WHERE proname = 'prune_request_outcomes')    AS prune_expect_1;
