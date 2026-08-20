-- ############################################################################
-- 0134 · THE AUDIT-GRADE EVENT STREAM, AND A CURSOR THAT CAN RESUME IT
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.81.0-alpha   ·   Migration number: 0134
-- Wave 14 · Track B (observability, SLOs and the evidence layer)
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY
-- ############################################################################
--
-- An enterprise buyer's security questionnaire asks one question five ways:
-- "show me every authentication, every permission change, every time your
-- staff went inside our workspace, and everything that was exported."
--
-- Every one of those facts IS recorded. They are recorded in six different
-- tables, with six different column names for the actor, three different
-- spellings of the timestamp, and no way to ask them one question:
--
--   security_events                every refusal worth alarming about (0012)
--   audit_logs                     every tenant-side action, hash-chained (0002)
--   permission_denials             every refused permission (0031)
--   data_exports                   every disclosure (0116)
--   platform_impersonation_sessions  every time we went inside (0014)
--   platform_action_log            every staff action, hash-chained (0014)
--
-- ⚠️ AND `lib/security/siem.ts` — the NDJSON and CEF serialisers, the export
--    cursor, 38 assertions of test coverage — HAS NEVER BEEN CALLED BY
--    ANYTHING. Verified by grep at v1.81.0-alpha: outside its own file and
--    `scripts/check-security-events.mjs`, there are no importers. It is a
--    wire format with no wire.
--
-- ⭐ THIS FILE GIVES IT ONE. A single view with one shape over all six, plus
--    a durable cursor so an exporter can resume rather than re-send the year.
--
-- ############################################################################
-- 🔴 THE TRAP IN THIS FILE, AND IT WOULD HAVE SHIPPED A CROSS-TENANT READ
-- ############################################################################
--
-- A Postgres view executes with the permissions and the RLS context of its
-- OWNER, not its caller, unless it is explicitly created `WITH
-- (security_invoker = true)`. The owner here is `neondb_owner`, which owns
-- every underlying table.
--
-- So the default — the thing you get by writing `CREATE VIEW` and nothing
-- else — is a view that reads every tenant's security events and hands them
-- to whoever can SELECT it. Tenant isolation in this product is row-level
-- security and nothing else; a view is a hole straight through it, and it
-- has no symptom: the query returns rows, the page renders, and the rows
-- belong to somebody else.
--
-- ⚠️ `security_invoker` IS POSTGRES 15+. Neon runs 16. On anything older
--    this file must not be applied, which is why section ③ RAISES on the
--    reloption rather than trusting that the CREATE succeeded — a `WITH`
--    clause that the server silently ignored would leave exactly the view
--    this paragraph exists to prevent.
--
-- ############################################################################
-- ⚠️ WHAT THE STREAM DELIBERATELY DOES NOT CONTAIN
-- ############################################################################
--
-- 🔴 PLATFORM SCOPE RAISES. §6.4 of this track's brief asks for them and they
--    are NOT here, because they are not recorded anywhere to read from.
--    `withPlatformScope()` in `db/index.ts` takes a mandatory justification
--    string and then does this with it:
--
--        if (process.env.NODE_ENV !== "production") console.warn(...)
--
--    In production it is discarded. Every cross-tenant read in this product
--    is therefore unlogged, and no view can invent the rows. Recording them
--    needs a change to `db/index.ts`, which Track B does not own — see
--    `PATCH-REQUEST-B.md`, which carries the code.
--
-- ⚠️ ROW CONTENTS. `audit_logs.old_value` and `new_value` hold what changed,
--    which in this product is customer data. The view exposes the metadata
--    jsonb and NOT those two columns. An "audit stream" that a SOC ingests is
--    a copy of everything in it, in somebody else's system, under somebody
--    else's retention policy.
--
-- ############################################################################
-- IS THERE DATA LOSS?  No. One table created, one view created. No writes.
--
-- RUN ORDER: after 0116 (data_exports) and after 0133. SQL FIRST — the
-- exporter in server/security/siem.ts probes for the view with to_regclass
-- and reports its absence rather than failing.
--
-- ⚠️ NO BEGIN/COMMIT. See 0133 for why.
-- ############################################################################


-- ============================================================================
-- ① THE CURSOR TABLE
-- ============================================================================
--
-- ⚠️ ONE ROW PER DESTINATION, NOT ONE ROW PER RUN. The question is "where did
--    the Splunk feed get to", and a run history answers it only by max().
--    A run history is also a table that grows forever to hold one useful fact.
--
-- ⚠️ NO tenant_id, AND THAT IS A DECISION. Export is a platform act across
--    every workspace; a per-tenant cursor would imply per-tenant feeds, which
--    is a product decision nobody has made. The RLS policy below is therefore
--    platform-scope-only in BOTH directions — the only table in this track
--    with no tenant branch at all.

CREATE TABLE IF NOT EXISTS public.siem_export_cursors (
    destination        varchar(64)  PRIMARY KEY,
    format             varchar(8)   NOT NULL DEFAULT 'ndjson',

    -- The high-water mark: the (created_at, id) of the last row shipped.
    -- NULL means "never exported"; the first run then starts from the
    -- beginning, which is correct and is why there is no sentinel date.
    cursor_created_at  timestamptz,
    cursor_id          varchar(160),

    last_exported_at   timestamptz,
    last_error         text,
    exported_total     bigint       NOT NULL DEFAULT 0,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siem_export_cursors_format_known') THEN
        ALTER TABLE public.siem_export_cursors ADD CONSTRAINT siem_export_cursors_format_known
            CHECK (format IN ('ndjson','cef'));
    END IF;

    -- ⚠️ BOTH HALVES OF THE CURSOR, OR NEITHER. A row with a timestamp and no
    -- id produces a cursor that cannot break a same-millisecond tie, which is
    -- the exact failure `nextSiemCursor()` was written to avoid: skip a row
    -- (evidence lost) or repeat it forever (the export loops).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siem_export_cursors_pair_complete') THEN
        ALTER TABLE public.siem_export_cursors ADD CONSTRAINT siem_export_cursors_pair_complete
            CHECK ((cursor_created_at IS NULL) = (cursor_id IS NULL));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siem_export_cursors_total_sane') THEN
        ALTER TABLE public.siem_export_cursors ADD CONSTRAINT siem_export_cursors_total_sane
            CHECK (exported_total >= 0);
    END IF;
END
$$;

ALTER TABLE public.siem_export_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.siem_export_cursors FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS siem_export_cursors_platform_only ON public.siem_export_cursors;
CREATE POLICY siem_export_cursors_platform_only
    ON public.siem_export_cursors
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        REVOKE ALL ON public.siem_export_cursors FROM ordence_app;
        -- No DELETE: deleting a cursor silently re-exports the entire history
        -- to a customer's SOC, which is a disclosure event, not a reset.
        GRANT SELECT, INSERT, UPDATE ON public.siem_export_cursors TO ordence_app;
    END IF;
END
$$;



-- ============================================================================
-- ②b THE updated_at SWEEP — CALLED, NOT ASSUMED
-- ============================================================================
--
-- 🔴 WITHOUT THIS, `npm run test:security` FAILS:
--
--     tests/security/wave13-coverage.test.ts
--     › every updated_at column is actually maintained
--     AssertionError: these tables have an updated_at that is set once on
--     INSERT and never moves again: expected [ 'siem_export_cursors' ]
--
-- ⚠️ THE DEFECT THAT TEST EXISTS FOR IS SUBTLE AND THIS TABLE IS EXACTLY ITS
--    SHAPE. `updated_at timestamptz NOT NULL DEFAULT now()` looks maintained.
--    It is set once and never moves, so "when did this export feed last
--    change" answers with the day the feed was created — a plausible
--    timestamp that is simply not the fact it claims to be.
--
-- ⚠️ `siem_export_cursors` HAS NO `tenant_id`, so it is out of scope for the
--    change-log and impersonation sweeps by construction. It is deliberately
--    a platform table, in the same class as `platform_action_log`.

SELECT * FROM public.attach_updated_at_triggers();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.siem_export_cursors'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            '0134 FAILED: siem_export_cursors has no updated_at trigger. Its updated_at would be set once on INSERT and never move, which reads as a timestamp and is not one.';
    END IF;
    RAISE NOTICE '0134 SWEEP PASS: the updated_at trigger is attached to siem_export_cursors.';
END
$$;

-- ============================================================================
-- ② THE STREAM
-- ============================================================================
--
-- ⚠️ EVERY COLUMN IS EXPLICITLY CAST. A UNION ALL infers its result types
--    from the FIRST branch, so an uncast varchar(60) in branch one silently
--    truncates a longer value in branch four. That is a data-loss bug with no
--    error, in the table that exists to be evidence.
--
-- ⚠️ `stream_id` IS `<table>:<uuid>`, NOT the bare uuid. Two rows in two
--    tables can share a uuid, and the export cursor compares ids to break a
--    same-millisecond tie — an ambiguous id there means a row is skipped or
--    repeated forever. The prefix also tells a SOC analyst which table to go
--    and read, which a bare uuid does not.

DROP VIEW IF EXISTS public.security_event_stream;

CREATE VIEW public.security_event_stream
WITH (security_invoker = true) AS

    -- ① The security vocabulary itself.
    SELECT
        'security'::text                            AS stream,
        ('security_events:' || se.id::text)::text   AS stream_id,
        se.id                                       AS source_id,
        'security_events'::text                     AS source_table,
        se.occurred_at                              AS occurred_at,
        se.created_at                               AS recorded_at,
        se.tenant_id                                AS tenant_id,
        se.event_type::text                         AS event_type,
        se.severity::text                           AS severity,
        se.source::text                             AS event_source,
        se.actor_user_id                            AS actor_user_id,
        NULL::text                                  AS actor_email,
        se.subject_type::text                       AS subject_type,
        se.subject_id::text                         AS subject_id,
        se.ip_address::text                         AS ip_address,
        se.ip_prefix::text                          AS ip_prefix,
        se.request_id::text                         AS request_id,
        se.route::text                              AS route,
        se.country::text                            AS country,
        se.occurrence_count                         AS occurrence_count,
        se.detail                                   AS detail,
        se.reason::text                             AS reason
      FROM public.security_events se

    UNION ALL

    -- ② Tenant-side actions that are security facts rather than bookkeeping.
    -- ⚠️ FILTERED, NOT WHOLESALE. audit_logs holds every create/read/update in
    -- the product; shipping all of it to a SOC is shipping the product's
    -- traffic, not its security events, and it buries the five actions that
    -- matter under a million that do not.
    SELECT
        'audit'::text,
        ('audit_logs:' || al.id::text)::text,
        al.id,
        'audit_logs'::text,
        al.created_at,
        al.created_at,
        al.tenant_id,
        ('audit.' || al.action::text)::text,
        al.severity::text,
        COALESCE(al.actor_role, 'unknown')::text,
        al.actor_user_id,
        al.actor_email::text,
        al.resource_type::text,
        al.resource_id::text,
        host(al.ip_address)::text,
        NULL::text,
        al.request_id::text,
        NULL::text,
        al.country::text,
        1,
        -- ⚠️ metadata ONLY. old_value and new_value are the customer's data.
        COALESCE(al.metadata, '{}'::jsonb),
        al.reason::text
      FROM public.audit_logs al
     WHERE al.action IN (
        'login','logout','login_failed','permission_change','role_change',
        'export','impersonate','config_change','security_event'
     )

    UNION ALL

    -- ③ Refused permissions. A denial spike is the earliest signal of a
    -- compromised session that this product produces.
    SELECT
        'authz'::text,
        ('permission_denials:' || pd.id::text)::text,
        pd.id,
        'permission_denials'::text,
        pd.created_at,
        pd.created_at,
        pd.tenant_id,
        'authz.denied'::text,
        CASE WHEN pd.was_dangerous THEN 'warning' ELSE 'info' END::text,
        COALESCE(pd.actor_role, 'unknown')::text,
        pd.user_id,
        NULL::text,
        COALESCE(pd.resource_type, 'permission')::text,
        COALESCE(pd.resource_id, pd.permission)::text,
        pd.ip_address::text,
        NULL::text,
        pd.request_id::text,
        NULL::text,
        NULL::text,
        1,
        jsonb_build_object('permission', pd.permission, 'dangerous', pd.was_dangerous),
        NULL::text
      FROM public.permission_denials pd

    UNION ALL

    -- ④ Disclosures. 0116 exists because "what did they take" had no answer.
    SELECT
        'export'::text,
        ('data_exports:' || de.id::text)::text,
        de.id,
        'data_exports'::text,
        de.occurred_at,
        de.occurred_at,
        de.tenant_id,
        'export.performed'::text,
        CASE WHEN de.includes_personal_data THEN 'warning' ELSE 'notice' END::text,
        COALESCE(de.subject, 'export')::text,
        de.exported_by,
        NULL::text,
        'dataset'::text,
        array_to_string(de.dataset_keys, ',')::text,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        1,
        jsonb_build_object(
            'format', de.format,
            'rowCount', de.row_count,
            'byteCount', de.byte_count,
            'includesPersonalData', de.includes_personal_data,
            'outcome', de.outcome
        ),
        de.failure_reason::text
      FROM public.data_exports de

    UNION ALL

    -- ⑤ Every time we went inside a customer's workspace.
    SELECT
        'impersonation'::text,
        ('platform_impersonation_sessions:' || pis.id::text)::text,
        pis.id,
        'platform_impersonation_sessions'::text,
        pis.started_at,
        pis.created_at,
        pis.tenant_id,
        ('impersonation.' || pis.mode::text)::text,
        'warning'::text,
        pis.scope::text,
        pis.staff_id,
        pis.actor_email::text,
        'tenant'::text,
        pis.tenant_slug::text,
        host(pis.ip_address)::text,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        1,
        jsonb_build_object(
            'endedAt',  pis.ended_at,
            'endedReason', pis.ended_reason,
            'actionCount', pis.action_count,
            'blockedActionCount', pis.blocked_action_count,
            'tenantNotifiedAt', pis.tenant_notified_at
        ),
        pis.justification
      FROM public.platform_impersonation_sessions pis

    UNION ALL

    -- ⑥ Staff actions in the console.
    -- ⚠️ tenant_id IS NULL FOR EVERY ROW because platform_action_log has no
    -- such column — a staff action is a platform fact and is attributed to a
    -- workspace, when it is, through resource_id. Under `security_invoker`
    -- this branch is therefore visible ONLY under platform scope, which is
    -- correct: a tenant should not read our staff register.
    SELECT
        'platform'::text,
        ('platform_action_log:' || pal.id::text)::text,
        pal.id,
        'platform_action_log'::text,
        pal.created_at,
        pal.created_at,
        NULL::uuid,
        ('platform.' || pal.action::text)::text,
        COALESCE(pal.severity, 'notice')::text,
        pal.actor_grade::text,
        NULL::uuid,
        pal.actor_email::text,
        pal.resource_type::text,
        pal.resource_id::text,
        host(pal.ip_address)::text,
        NULL::text,
        pal.request_id::text,
        NULL::text,
        NULL::text,
        COALESCE(pal.result_count, 1),
        COALESCE(pal.metadata, '{}'::jsonb),
        pal.justification
      FROM public.platform_action_log pal;

COMMENT ON VIEW public.security_event_stream IS
    'One shape over the six tables that hold this product''s security facts. security_invoker = true, so a tenant session sees exactly its own rows and a platform-scoped session sees all of them. Deliberately excludes audit_logs.old_value/new_value (customer data) and cannot include withPlatformScope() raises, which are not recorded anywhere — see PATCH-REQUEST-B.md.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT ON public.security_event_stream TO ordence_app;
    END IF;
END
$$;


-- ============================================================================
-- ③ VERIFY — AND RAISE IF THE CHANGE DID NOT TAKE
-- ============================================================================

DO $$
DECLARE
    opts       text[];
    n_branches integer := 0;
    forced     boolean;
    viewdef    text;
    t          text;
BEGIN
    IF to_regclass('public.siem_export_cursors') IS NULL THEN
        RAISE EXCEPTION '0134 FAILED: siem_export_cursors was not created.';
    END IF;

    SELECT relforcerowsecurity INTO forced FROM pg_class
     WHERE oid = 'public.siem_export_cursors'::regclass;
    IF forced IS NOT TRUE THEN
        RAISE EXCEPTION '0134 FAILED: siem_export_cursors does not FORCE row level security.'
            USING ERRCODE = '42501';
    END IF;

    IF to_regclass('public.security_event_stream') IS NULL THEN
        RAISE EXCEPTION '0134 FAILED: security_event_stream was not created.';
    END IF;

    -- 🔴 THE ONE THAT MATTERS. A `WITH (security_invoker = true)` the server
    -- ignored leaves a view that reads every tenant's rows for whoever asks.
    SELECT reloptions INTO opts FROM pg_class
     WHERE oid = 'public.security_event_stream'::regclass;
    IF opts IS NULL OR NOT ('security_invoker=true' = ANY(opts)) THEN
        RAISE EXCEPTION
            '0134 FAILED: security_event_stream is NOT security_invoker. It would execute as its owner, which owns every underlying table, and hand one tenant another tenant''s security events. Requires PostgreSQL 15 or later.'
            USING ERRCODE = '42501';
    END IF;

    -- ⚠️ 🔴 THIS CHECK WAS WRITTEN WRONG FIRST TIME AND THE FIRST VERSION IS
    -- WORTH RECORDING, because it is this repository's signature defect
    -- committed inside the file that is meant to close it. It read:
    --
    --     SELECT count(*) FROM (SELECT DISTINCT source_table FROM ...
    --       UNION ALL SELECT unnest(ARRAY['security_events', ...])) x
    --
    -- The UNION ALL against a literal six-element array makes the count six
    -- or more UNCONDITIONALLY — on an empty database, on a view with one
    -- branch, on a view with none. It passed, and it could not have failed.
    --
    -- ⭐ SO THE BRANCH CHECK READS THE VIEW DEFINITION, which is the only
    -- thing that actually says which tables the view selects from. `count(*)`
    -- over the view's own rows can never distinguish "this branch is missing"
    -- from "this branch has no rows yet", and on a fresh database every
    -- branch has no rows yet.
    SELECT pg_get_viewdef('public.security_event_stream'::regclass, true) INTO viewdef;
    FOREACH t IN ARRAY ARRAY['security_events','audit_logs','permission_denials',
                             'data_exports','platform_impersonation_sessions',
                             'platform_action_log']
    LOOP
        IF position(t IN viewdef) = 0 THEN
            RAISE EXCEPTION
                '0134 FAILED: security_event_stream does not read %. A stream that silently stopped carrying one of the six is an evidence gap that reads as a quiet month.', t
                USING ERRCODE = '42704';
        END IF;
        n_branches := n_branches + 1;
    END LOOP;

    RAISE NOTICE '0134 PASS: siem_export_cursors created with FORCE RLS and a platform-only policy; security_event_stream created over % source tables with security_invoker = true.', n_branches;
END
$$;

SELECT
    'SQL 0134 · audit-grade event stream'                                       AS migration,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'siem_export_cursors')     AS cursor_table_expect_1,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'siem_export_cursors')        AS policy_expect_1,
    (SELECT count(*) FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'security_event_stream')   AS view_expect_1,
    (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class
      WHERE oid = 'public.security_event_stream'::regclass)                     AS invoker_expect_true;
