-- ############################################################################
-- 0135 · ALERTS THAT CANNOT BE RAISED WITHOUT A RUNBOOK, AND A RATE LIMIT
--        THAT COUNTS ACROSS INSTANCES
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.81.0-alpha   ·   Migration number: 0135
-- Wave 14 · Track B (observability, SLOs and the evidence layer)
--
-- ############################################################################
-- 🔴 THE TWO FAILURES THIS TABLE EXISTS TO MAKE IMPOSSIBLE
-- ############################################################################
--
-- ① AN ALERT WITH NOWHERE TO GO.
--    `runbook_key` is NOT NULL with a length CHECK. There is no code path
--    that can raise an alert without naming the paragraph that says what to
--    do about it, because the database refuses the row.
--
--    This is deliberately a constraint rather than a code review rule. Every
--    alert added in a hurry during an incident is added by somebody who knows
--    what to do about it and will write it down later. An alert nobody can
--    action is not neutral — it trains the on-call to ignore the channel, and
--    it takes the actionable alerts down with it.
--
-- ② A RATE LIMIT THAT COUNTS PER PROCESS.
--    `lib/security/rate-limit.ts` has said since Phase 20: "Per-instance
--    memory counters are a speed bump, not a control: on a serverless
--    deployment the effective limit is (limit × instances)." Wave 8 found
--    that had been literally true of the auth limiter for the life of the
--    deployment, because `UPSTASH_REDIS_REST_*` was never set.
--
--    ⭐ SO THE LIMITER HERE IS A UNIQUE KEY AND AN UPSERT, IN POSTGRES. One
--    statement, atomic under READ COMMITTED, correct with any number of
--    Railway instances and with no Redis:
--
--        INSERT ... ON CONFLICT (alert_key, tenant_id, window_start)
--        DO UPDATE SET raise_count = raise_count + 1, suppressed_count = ...
--        RETURNING (xmax = 0) AS was_inserted
--
--    `xmax = 0` on the returned row is true only when the INSERT actually
--    inserted. That single boolean is the whole decision: true means this is
--    the first raise in the window and the message goes out; false means the
--    window already fired and the raise is counted, not sent.
--
--    ⚠️ AND THE SUPPRESSED RAISES ARE COUNTED, NOT DISCARDED. A limiter whose
--    suppressions are invisible is indistinguishable from a detector that
--    stopped detecting. `suppressed_count` is what the status surface shows
--    beside "1 alert" so nobody reads one message as one event.
--
-- ############################################################################
-- ⚠️ THE WEBHOOK URL IS NOT IN THIS FILE, NOT IN ANY FILE, AND NOT IN A ROW
-- ############################################################################
--
-- The Discord destination is read from the environment at dispatch time by
-- `server/observability/alerts.ts`. It is a credential: anybody holding it can
-- post into the operations channel as us, which is a convincing place from
-- which to tell an engineer to do something. It is therefore never written to
-- a column, never logged, and never included in `detail`.
--
-- `delivery_error` stores the provider's status code and a bounded message.
-- The dispatcher strips anything URL-shaped before it gets here, because the
-- one string a failing HTTP client most likes to put in an error is the URL
-- it was calling.
--
-- ############################################################################
-- IS THERE DATA LOSS?  No. One table, one retention function that is created
-- and not run.
--
-- RUN ORDER: after 0133. SQL FIRST — the dispatcher probes for the table and
-- degrades to "log the alert, do not send it" if it is absent, which is the
-- honest failure rather than a silent one.
--
-- ⚠️ NO BEGIN/COMMIT. See 0133.
-- ############################################################################


-- ============================================================================
-- ① THE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.observability_alerts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What fired. `slo.burn:app.availability:fast`, `tenant.error_rate`, …
    alert_key           varchar(120) NOT NULL,

    -- 🔴 THE RUNBOOK. NOT NULL, and non-empty by CHECK. See the header.
    runbook_key         varchar(80)  NOT NULL,

    -- Which workspace, when the alert is about one. NULL means platform-wide.
    -- SET NULL rather than CASCADE: an alert about a workspace that has since
    -- been deleted is still a thing that happened, and deleting the workspace
    -- must not delete the record of the incident it caused.
    tenant_id           uuid REFERENCES public.tenants(id) ON DELETE SET NULL,

    severity            varchar(10)  NOT NULL DEFAULT 'warning',
    title               varchar(200) NOT NULL,

    -- Bounded, allow-listed context. Never a payload, never a record.
    detail              jsonb        NOT NULL DEFAULT '{}'::jsonb,

    -- The rate-limit bucket. Aligned by the writer; the CHECK below refuses a
    -- bucket that is not on a minute boundary, so a caller that forgets to
    -- truncate gets an error rather than a limiter with a window of one
    -- microsecond, which is a limiter that does not limit.
    window_start        timestamptz  NOT NULL,

    first_raised_at     timestamptz  NOT NULL DEFAULT now(),
    last_raised_at      timestamptz  NOT NULL DEFAULT now(),
    raise_count         integer      NOT NULL DEFAULT 1,
    suppressed_count    integer      NOT NULL DEFAULT 0,

    delivered_at        timestamptz,
    delivery_error      text,

    -- ⭐ WHAT SOMEBODY DID ABOUT IT. The reason "recent incidents" on the
    -- status surface is worth reading: an alert with no acknowledgement after
    -- an hour is a different fact from one somebody closed in four minutes.
    acknowledged_at     timestamptz,
    acknowledged_by     varchar(320),
    acknowledgement_note text
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'observability_alerts_window_unique'
           AND conrelid = 'public.observability_alerts'::regclass
    ) THEN
        -- ⚠️ NULLS NOT DISTINCT, for the same reason as 0133: a platform-wide
        -- alert has tenant_id NULL, and under the default every raise would
        -- INSERT a new row instead of conflicting — so the alerts that need
        -- rate limiting most (the platform-wide ones) would be the only ones
        -- with no rate limit at all.
        ALTER TABLE public.observability_alerts
            ADD CONSTRAINT observability_alerts_window_unique
            UNIQUE NULLS NOT DISTINCT (alert_key, tenant_id, window_start);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observability_alerts_runbook_present') THEN
        ALTER TABLE public.observability_alerts ADD CONSTRAINT observability_alerts_runbook_present
            CHECK (length(btrim(runbook_key)) >= 3);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observability_alerts_severity_known') THEN
        ALTER TABLE public.observability_alerts ADD CONSTRAINT observability_alerts_severity_known
            CHECK (severity IN ('info','notice','warning','critical'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observability_alerts_window_aligned') THEN
        ALTER TABLE public.observability_alerts ADD CONSTRAINT observability_alerts_window_aligned
            CHECK (window_start = date_trunc('minute', window_start));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observability_alerts_counts_sane') THEN
        ALTER TABLE public.observability_alerts ADD CONSTRAINT observability_alerts_counts_sane
            CHECK (raise_count >= 1 AND suppressed_count >= 0 AND last_raised_at >= first_raised_at);
    END IF;

    -- ⚠️ AN ACKNOWLEDGEMENT WITH NO NAME ON IT IS NOT AN ACKNOWLEDGEMENT.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observability_alerts_ack_complete') THEN
        ALTER TABLE public.observability_alerts ADD CONSTRAINT observability_alerts_ack_complete
            CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL));
    END IF;
END
$$;


-- ============================================================================
-- ② INDEXES
-- ============================================================================

-- "What has fired recently", which is the only question the status surface asks.
CREATE INDEX IF NOT EXISTS observability_alerts_recent_idx
    ON public.observability_alerts (last_raised_at DESC);

-- "Is this workspace noisy", for the per-tenant health view.
CREATE INDEX IF NOT EXISTS observability_alerts_tenant_idx
    ON public.observability_alerts (tenant_id, last_raised_at DESC);

-- "Anything still unacknowledged", partial so it stays small forever.
CREATE INDEX IF NOT EXISTS observability_alerts_open_idx
    ON public.observability_alerts (last_raised_at DESC)
    WHERE acknowledged_at IS NULL;


-- ============================================================================
-- ③ ROW-LEVEL SECURITY
-- ============================================================================
--
-- 🔴 THE FIRST VERSION OF THIS SECTION WAS REFUSED BY `npm run check:rls`
--    AND THE REFUSAL IS RECORDED HERE RATHER THAN QUIETLY FIXED.
--
-- It was platform-only in both directions:
--
--     USING      (app_platform_scope())
--     WITH CHECK (app_platform_scope())
--
-- with the argument that an alert row is an operator artefact carrying our
-- thresholds and our judgement, so a tenant should not read it. The gate,
-- run against a live PostgreSQL as a NOBYPASSRLS role, returned two errors:
--
--     observability_alerts has RLS enabled but no policy referencing
--     app_current_tenant_id() — RLS with no policy denies everything.
--
--     observability_alerts allows app_platform_scope() in WITH CHECK —
--     that permits a cross-tenant WRITE.
--
-- ⚠️ THE SECOND ONE IS THE REAL FINDING AND THE ARGUMENT ABOVE DOES NOT
--    ANSWER IT. A bare platform-scope WITH CHECK means any platform-scoped
--    code path can attribute a row to any workspace. "Nothing reads it from
--    a tenant session" is a claim about today's screens, not about the
--    boundary; the boundary is the policy.
--
-- ⭐ SO THIS TABLE USES THE SAME SHAPE AS `request_outcomes` (0133) AND AS
--    `email_suppressions`, which `scripts/check-rls-coverage.mjs` names as
--    the idiom that needs no opt-in:
--
--      READ   a workspace's own rows; every row under platform scope,
--             because the status surface is cross-tenant by definition.
--      WRITE  a workspace's own rows only in that workspace's own scope.
--             Platform scope may write ONLY `tenant_id IS NULL` — a global
--             row, not another tenant's row.
--
-- ⚠️ THE COST, STATED: `server/observability/alerts.ts` must open the
--    workspace's own scope to raise a tenant-attributed alert, and again to
--    stamp its delivery receipt or its acknowledgement. That is thirty more
--    lines than the platform-only version. The alternative was an entry in
--    `OPT_IN_PLATFORM_WRITE` inside `scripts/check-rls-coverage.mjs` — a
--    file Track B does not own, and a list whose own docstring says adding
--    to it must be "a visible decision". Thirty lines is cheaper than a
--    decision somebody else has to make about our convenience.
--
-- 🔴 FORCE, because production connects as the table owner and a policy
--    without FORCE applies to nobody who matters.

ALTER TABLE public.observability_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observability_alerts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS observability_alerts_platform_only ON public.observability_alerts;
DROP POLICY IF EXISTS observability_alerts_tenant_isolation ON public.observability_alerts;
CREATE POLICY observability_alerts_tenant_isolation
    ON public.observability_alerts
    USING (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
        OR app_platform_scope()
    )
    WITH CHECK (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_platform_scope())
    );

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        REVOKE ALL ON public.observability_alerts FROM ordence_app;
        -- UPDATE is required: the rate limiter's ON CONFLICT DO UPDATE is the
        -- limiter. No DELETE — see the prune function below.
        GRANT SELECT, INSERT, UPDATE ON public.observability_alerts TO ordence_app;
    END IF;
END
$$;



-- ============================================================================
-- ③b THE CROSS-CUTTING SWEEPS — CALLED, NOT ASSUMED
-- ============================================================================
--
-- 🔴 WITHOUT THIS, `npm run test:security` FAILS:
--
--     tests/security/wave13-coverage.test.ts
--     › every tenant-scoped table refuses DELETE under impersonation
--     AssertionError: a support engineer inside an impersonation session can
--     DELETE from these tables: expected [ 'observability_alerts', … ]
--
-- ⭐ AND UNLIKE `request_outcomes` (0133), THIS TABLE IS **NOT** EXCLUDED
--    FROM change_log, deliberately. It is written a handful of times a day
--    rather than on every request, and the edits it receives — a delivery
--    receipt, an acknowledgement with somebody's name on it — are exactly
--    the kind of edit an incident review wants a second record of.

SELECT * FROM public.attach_impersonation_guards();
SELECT * FROM public.attach_change_log_triggers();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.observability_alerts'::regclass
           AND tgname  = 'no_delete_under_impersonation'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            '0135 FAILED: observability_alerts has no no_delete_under_impersonation trigger, so a support engineer wearing a customer''s face could delete the alerts raised about that customer.'
            USING ERRCODE = '42501';
    END IF;
    RAISE NOTICE '0135 SWEEPS PASS: impersonation delete guard and change recorder both attached.';
END
$$;

-- ============================================================================
-- ④ RETENTION — CREATED, NOT RUN
-- ============================================================================

DROP FUNCTION IF EXISTS public.prune_observability_alerts(integer, boolean);

CREATE OR REPLACE FUNCTION public.prune_observability_alerts(
    older_than_days integer DEFAULT 180,
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
    -- ⚠️ 90 DAYS, NOT 30. An alert history is what an incident review reads,
    -- and a quarterly review that cannot see the quarter is not a review.
    IF older_than_days < 90 THEN
        RAISE EXCEPTION
            'Refusing to prune observability_alerts younger than 90 days (asked for %). The alert history is what an incident review reads.',
            older_than_days
            USING ERRCODE = '22023';
    END IF;

    cutoff := date_trunc('minute', now() - make_interval(days => older_than_days));

    -- FORCE RLS applies to the owner; without this the DELETE matches zero
    -- rows and reports success. See 0128, which learned it the hard way.
    PERFORM set_config('app.platform_scope', 'on', true);

    IF dry_run THEN
        SELECT count(*) INTO removed FROM observability_alerts WHERE last_raised_at < cutoff;
    ELSE
        -- ⚠️ AN UNACKNOWLEDGED ALERT IS NEVER PRUNED, WHATEVER ITS AGE. If it
        -- is old and still open, that is the finding, and deleting it is
        -- deleting the finding.
        DELETE FROM observability_alerts
         WHERE last_raised_at < cutoff AND acknowledged_at IS NOT NULL;
        GET DIAGNOSTICS removed = ROW_COUNT;
    END IF;

    RETURN QUERY SELECT removed, cutoff, dry_run;
END
$fn$;

COMMENT ON FUNCTION public.prune_observability_alerts(integer, boolean) IS
    'Bounds the alert history. 180-day default, dry_run = true, refuses under 90 days, and NEVER removes an unacknowledged alert whatever its age — an old open alert is the finding, not the clutter.';

DO $$
BEGIN
    REVOKE ALL ON FUNCTION public.prune_observability_alerts(integer, boolean) FROM PUBLIC;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        REVOKE ALL ON FUNCTION public.prune_observability_alerts(integer, boolean) FROM ordence_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
        GRANT EXECUTE ON FUNCTION public.prune_observability_alerts(integer, boolean) TO ordence_maintenance;
    END IF;
END
$$;


-- ============================================================================
-- ⑤ VERIFY — AND RAISE IF THE CHANGE DID NOT TAKE
-- ============================================================================
--
-- ⚠️ THIS BLOCK DOES NOT ONLY COUNT OBJECTS. It EXERCISES the two properties
--    the table exists for — the runbook constraint and the atomic limiter —
--    and rolls them back. A migration that asserts a constraint exists has
--    asserted that a row is in pg_constraint, which is not the same claim as
--    "the constraint refuses the row it was written to refuse".

DO $$
DECLARE
    forced        boolean;
    n_checks      integer;
    runbook_held  boolean := false;
    was_inserted  boolean;
    second_insert boolean;
    probe_window  timestamptz := date_trunc('minute', now());
BEGIN
    IF to_regclass('public.observability_alerts') IS NULL THEN
        RAISE EXCEPTION '0135 FAILED: observability_alerts was not created.';
    END IF;

    SELECT relforcerowsecurity INTO forced FROM pg_class
     WHERE oid = 'public.observability_alerts'::regclass;
    IF forced IS NOT TRUE THEN
        RAISE EXCEPTION '0135 FAILED: FORCE ROW LEVEL SECURITY is off.' USING ERRCODE = '42501';
    END IF;

    SELECT count(*) INTO n_checks FROM pg_constraint
     WHERE conrelid = 'public.observability_alerts'::regclass AND contype = 'c';
    IF n_checks < 5 THEN
        RAISE EXCEPTION '0135 FAILED: expected at least 5 CHECK constraints, found %.', n_checks;
    END IF;

    PERFORM set_config('app.platform_scope', 'on', true);

    -- 🔴 PROOF ①: an alert with no runbook is REFUSED.
    BEGIN
        INSERT INTO observability_alerts (alert_key, runbook_key, severity, title, window_start)
        VALUES ('probe.no_runbook', '  ', 'warning', 'probe', probe_window);
    EXCEPTION WHEN check_violation THEN
        runbook_held := true;
    END;
    IF NOT runbook_held THEN
        RAISE EXCEPTION '0135 FAILED: an alert with a blank runbook_key was ACCEPTED. The constraint is the only thing standing between this channel and an unactionable alert.';
    END IF;

    -- 🔴 PROOF ②: the limiter. First raise inserts, second raise does not.
    INSERT INTO observability_alerts (alert_key, runbook_key, severity, title, window_start)
    VALUES ('probe.limiter', 'probe-runbook', 'info', 'probe', probe_window)
    ON CONFLICT (alert_key, tenant_id, window_start) DO UPDATE
        SET raise_count      = observability_alerts.raise_count + 1,
            suppressed_count = observability_alerts.suppressed_count + 1,
            last_raised_at   = now()
    RETURNING (xmax = 0) INTO was_inserted;

    INSERT INTO observability_alerts (alert_key, runbook_key, severity, title, window_start)
    VALUES ('probe.limiter', 'probe-runbook', 'info', 'probe', probe_window)
    ON CONFLICT (alert_key, tenant_id, window_start) DO UPDATE
        SET raise_count      = observability_alerts.raise_count + 1,
            suppressed_count = observability_alerts.suppressed_count + 1,
            last_raised_at   = now()
    RETURNING (xmax = 0) INTO second_insert;

    DELETE FROM observability_alerts WHERE alert_key = 'probe.limiter';

    IF was_inserted IS NOT TRUE OR second_insert IS NOT FALSE THEN
        RAISE EXCEPTION
            '0135 FAILED: the rate limiter does not discriminate. First raise reported inserted=%, second reported inserted=%. Expected true then false; anything else means every raise would be delivered.',
            was_inserted, second_insert;
    END IF;

    RAISE NOTICE '0135 PASS: observability_alerts exists with % CHECKs, FORCE RLS and the request_outcomes policy shape; a blank runbook_key was refused; the ON CONFLICT limiter reported inserted=true then inserted=false. Probe rows removed.', n_checks;
END
$$;

SELECT
    'SQL 0135 · observability alerts'                                              AS migration,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'observability_alerts')       AS table_expect_1,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'observability_alerts')          AS policy_expect_1,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.observability_alerts'::regclass AND contype = 'c')  AS checks_expect_5,
    (SELECT relforcerowsecurity FROM pg_class
      WHERE oid = 'public.observability_alerts'::regclass)                          AS force_rls_expect_true,
    (SELECT count(*) FROM public.observability_alerts WHERE alert_key LIKE 'probe.%') AS probe_rows_expect_0;
