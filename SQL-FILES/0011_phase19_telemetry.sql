-- ============================================================================
-- Ordence — Phase 19: Telemetry & Observability
-- Version: v0.12.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the two telemetry tables:
--   error_events, web_vital_events
--
-- Contents:
--   1. Row-Level Security (both tables, NULL-tenant allowance)
--   2. error_events is APPEND-ONLY
--   3. The telemetry_daily health view (security_invoker)
--   4. Retention — the sweep function, and why it is not scheduled
--   5. Grants
--   6. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Telemetry is the only subsystem in this platform that deliberately copies
-- fragments of a running application into a table engineers browse casually.
-- In a CRM those fragments are not neutral — a URL is `/contacts/<uuid>`, an
-- error message can contain an email address, a stack frame can carry a query
-- string containing a customer's name.
--
-- The application scrubs all of that (lib/telemetry/scrub.ts). This file is
-- the half that still holds when the application is wrong:
--
--   • A route pattern containing `?` or `://` CANNOT be stored.   (CHECK, from
--     the Drizzle schema — asserted in Section 6.)
--   • An error event, once written, CANNOT be altered.            (Section 2)
--   • A tenant session CANNOT read another tenant's events, and
--     CANNOT read the unattributed ones either.                   (Section 1)
--   • The health view CANNOT be used to bypass RLS.               (Section 3)
--
-- The last one is the subtle one and it is worth stating plainly: a view
-- created by the table owner runs with the OWNER's privileges, which means a
-- perfectly innocent "daily error counts" view would return EVERY TENANT'S
-- ROWS to any caller. `security_invoker = true` is what makes it obey the
-- caller's policies instead. It is a PostgreSQL 15+ feature; on anything
-- older, that view must not be created at all.
-- ============================================================================


-- The tenant-context accessor. Idempotent; also created by earlier phases.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER, which is usually the
-- role the application connects as. Without FORCE the isolation is decorative.

-- ---------------------------------------------------------------------------
-- BOTH TABLES CARRY THE `payment_events` NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- Every ordinary tenant-scoped table in this platform has a NOT NULL tenant_id
-- and a policy that is a plain equality. These two are different, for the same
-- structural reason `payment_events` is different, and the difference is worth
-- stating precisely because it looks like a hole.
--
-- A telemetry event can arrive with NO resolvable tenant, and not rarely:
--
--   • Web Vitals fire on the sign-in page and the marketing shell, where
--     there is no session at all.
--   • They fire during the first paint of an authenticated page, before the
--     session has resolved.
--   • A crash in the auth bootstrap has no tenant BY DEFINITION — and that is
--     the single most important error this system could ever record.
--
-- Refusing those events would mean the platform stops reporting precisely when
-- it is most broken. So they are recorded with tenant_id IS NULL, and the
-- policy permits READING them only when NO tenant context is set — i.e. from
-- the platform-scoped connection used by super-admin tooling.
--
--   tenant session (context = A)  ->  rows where tenant_id = A
--   platform scope (context NULL) ->  rows where tenant_id IS NULL
--
-- Note what this does NOT do: it does not let a tenant see another tenant's
-- events, and it does not let a tenant see the unattributed ones. The ingest
-- endpoint is public, so an anonymous POST can create a NULL row — and that
-- row is unreachable from every tenant session by this policy. Verified in
-- Section 6 and in tests/security/telemetry-isolation.test.ts.
--
-- WITH CHECK mirrors USING on both. A USING-only policy filters reads and
-- happily permits INSERTing a row attributed to somebody else — a write-side
-- leak that looks correct in every read-path test.
-- ---------------------------------------------------------------------------

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS error_events_tenant_isolation ON error_events;
CREATE POLICY error_events_tenant_isolation ON error_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  );


ALTER TABLE web_vital_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_vital_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_vital_events_tenant_isolation ON web_vital_events;
CREATE POLICY web_vital_events_tenant_isolation ON web_vital_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  );


-- ############################################################################
-- SECTION 2 — error_events IS APPEND-ONLY
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   An error report is only worth anything if it is the same tomorrow as it
--   was today. The moment a row can be UPDATEd, "we fixed it" and "somebody
--   edited the evidence" become indistinguishable — and a support conversation
--   that turns on "your system logged this at 14:02" needs the log to be
--   something you can point at, not something you have to vouch for.
--
--   DELETE is blocked by the same trigger, with one deliberate exception: the
--   retention sweep in Section 4 needs to remove old rows, and it does so by
--   setting a session flag the trigger honours. That is a narrow, greppable,
--   explicitly-named escape hatch rather than a hole — an ordinary DELETE,
--   including one an application bug issues, still raises.
--
-- `web_vital_events` is NOT append-only. It is a measurement, not evidence;
-- it is the highest-volume table in the platform; and it is the one that most
-- needs cheap bulk deletion. Nothing about a p75 is disputable later.

CREATE OR REPLACE FUNCTION error_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The retention sweep sets this flag transaction-locally before deleting.
  -- `current_setting(..., true)` returns NULL rather than raising when the
  -- setting has never been defined, which is the normal case for every other
  -- statement in the system.
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('app.telemetry_retention_sweep', true), '') = 'on'
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'error_events is append-only. % is not permitted on error evidence. '
    'Retention removal must run through telemetry_retention_sweep().',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS error_events_no_update ON error_events;
CREATE TRIGGER error_events_no_update
  BEFORE UPDATE ON error_events
  FOR EACH ROW EXECUTE FUNCTION error_events_block_mutation();

DROP TRIGGER IF EXISTS error_events_no_delete ON error_events;
CREATE TRIGGER error_events_no_delete
  BEFORE DELETE ON error_events
  FOR EACH ROW EXECUTE FUNCTION error_events_block_mutation();


-- ############################################################################
-- SECTION 3 — THE `telemetry_daily` HEALTH VIEW
-- ############################################################################
--
-- Per-tenant, per-day health signal: how many errors, how many were fatal,
-- how many DISTINCT bugs, and the p75 of each Core Web Vital.
--
-- ⚠️ `security_invoker = true` IS THE MOST IMPORTANT TOKEN IN THIS SECTION.
--
-- A view is executed with the privileges of its OWNER unless told otherwise.
-- The owner here is the role that ran this migration, which owns the tables
-- and therefore satisfies their policies trivially. Without this option, every
-- tenant querying `telemetry_daily` would receive AGGREGATES OVER EVERY
-- TENANT'S ROWS — a cross-platform data leak wearing the costume of a
-- dashboard, and one that no read-path test on the base tables would catch.
--
-- With it, the view is evaluated under the CALLER's context, so the same RLS
-- policies from Section 1 apply. Requires PostgreSQL 15+.
--
-- WHY p75 AND NOT AN AVERAGE: an average page load is dominated by the fast
-- majority and hides the tail entirely. Google's own Core Web Vitals
-- assessment is defined at the 75th percentile precisely because that is the
-- number that corresponds to "most of my users are having a bad time".
--
-- WHY A PLAIN VIEW AND NOT MATERIALIZED: a materialised view needs a refresh
-- job, and a stale health dashboard that looks live is worse than a slow one.
-- If this stops being fast enough, the answer is a real rollup TABLE written
-- by the retention sweep — noted as future work, not built speculatively.

DROP VIEW IF EXISTS telemetry_daily;

CREATE VIEW telemetry_daily
WITH (security_invoker = true) AS
WITH errors AS (
  SELECT
    tenant_id,
    date_trunc('day', captured_at)                                  AS day,
    count(*)                                                        AS error_count,
    count(*) FILTER (WHERE severity = 'fatal')                      AS fatal_count,
    count(DISTINCT fingerprint)                                     AS distinct_bugs,
    -- Which bug dominated the day. `mode()` rather than a window function
    -- because it stays correct when two fingerprints tie (it picks one
    -- deterministically) and it is a single pass.
    mode() WITHIN GROUP (ORDER BY fingerprint)                      AS top_fingerprint
  FROM error_events
  GROUP BY 1, 2
),
vitals AS (
  SELECT
    tenant_id,
    date_trunc('day', captured_at)                                  AS day,
    count(*)                                                        AS vital_samples,
    -- percentile_cont interpolates, which is what you want for a latency
    -- percentile; percentile_disc would snap to an observed value and make
    -- small samples jump between measurements.
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'LCP')                                 AS p75_lcp,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'INP')                                 AS p75_inp,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'CLS')                                 AS p75_cls,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'TTFB')                                AS p75_ttfb,
    count(*) FILTER (WHERE rating = 'poor')                         AS poor_samples
  FROM web_vital_events
  GROUP BY 1, 2
)
-- FULL OUTER JOIN, not INNER: a day with errors but no vitals (a server-side
-- outage on a page nobody loaded successfully) and a day with vitals but no
-- errors are both real and both must appear. An inner join would silently drop
-- the outage day, which is the one anybody is looking for.
SELECT
  COALESCE(e.tenant_id, v.tenant_id)      AS tenant_id,
  COALESCE(e.day, v.day)                  AS day,
  COALESCE(e.error_count, 0)              AS error_count,
  COALESCE(e.fatal_count, 0)              AS fatal_count,
  COALESCE(e.distinct_bugs, 0)            AS distinct_bugs,
  e.top_fingerprint                       AS top_fingerprint,
  COALESCE(v.vital_samples, 0)            AS vital_samples,
  v.p75_lcp,
  v.p75_inp,
  v.p75_cls,
  v.p75_ttfb,
  COALESCE(v.poor_samples, 0)             AS poor_vital_samples
FROM errors e
FULL OUTER JOIN vitals v
  ON  e.day = v.day
  -- `IS NOT DISTINCT FROM` rather than `=`, because tenant_id is NULLABLE
  -- here and `NULL = NULL` is NULL, not true. With a plain `=` every
  -- unattributed day would appear TWICE — once from each side of the join —
  -- with half its columns empty, and the platform-scope dashboard would show
  -- double-counted rows that look like a data corruption bug.
  AND e.tenant_id IS NOT DISTINCT FROM v.tenant_id;

COMMENT ON VIEW telemetry_daily IS
  'Per-tenant daily health rollup. security_invoker=true — RLS applies to the '
  'CALLER, not the view owner. Do not recreate this view without that option.';


-- ############################################################################
-- SECTION 4 — RETENTION
-- ############################################################################
--
-- ⚠️ NOTHING BELOW IS SCHEDULED. READ THIS BEFORE ASSUMING RETENTION WORKS.
--
-- Diagnostics kept forever are diagnostics that eventually become a disclosure
-- question, even when scrubbed — an error message that survived the scrubber
-- with a customer's name in it is a personal-data record under the DPDP Act,
-- and "we did not know it was there" is not a defence for keeping it for five
-- years. Retention is a real obligation, not housekeeping.
--
-- The function is defined here and the indexes exist to make it a cheap ranged
-- delete. What does NOT exist is anything that CALLS it: this platform has no
-- scheduler in place (no pg_cron on Neon by default, no Vercel Cron entry for
-- it), and adding one touches files owned by another workstream this phase.
-- Written up as required follow-up in docs/PHASE-19-NOTES.md.
--
-- Until it is scheduled, retention is a MANUAL operation. Say so out loud
-- rather than letting a defined-but-uncalled function imply otherwise.

CREATE OR REPLACE FUNCTION telemetry_retention_sweep(p_days integer DEFAULT 90)
RETURNS TABLE (deleted_errors bigint, deleted_vitals bigint)
LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamptz;
  n_errors bigint;
  n_vitals bigint;
BEGIN
  IF p_days < 7 THEN
    -- A sweep with a tiny window is almost always a typo (`7` meant as days
    -- typed as `0`), and it destroys the data you were about to investigate.
    RAISE EXCEPTION 'telemetry_retention_sweep: refusing a retention window under 7 days (got %)', p_days;
  END IF;

  cutoff := now() - make_interval(days => p_days);

  -- Transaction-local, so the append-only trigger's exception is back in force
  -- the moment this function's transaction ends. `true` is what makes it
  -- local; `false` would set it for the whole pooled CONNECTION and leave the
  -- next request on that connection able to delete error evidence at will.
  PERFORM set_config('app.telemetry_retention_sweep', 'on', true);

  DELETE FROM error_events WHERE captured_at < cutoff;
  GET DIAGNOSTICS n_errors = ROW_COUNT;

  DELETE FROM web_vital_events WHERE captured_at < cutoff;
  GET DIAGNOSTICS n_vitals = ROW_COUNT;

  PERFORM set_config('app.telemetry_retention_sweep', 'off', true);

  deleted_errors := n_errors;
  deleted_vitals := n_vitals;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION telemetry_retention_sweep(integer) IS
  'Manual retention sweep. NOT scheduled — see SQL-FILES/0011 Section 4.';


-- ############################################################################
-- SECTION 5 — GRANTS
-- ############################################################################
--
-- Replace `ordence_app` with the role your application actually connects as.
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — the first thing most people do when a query fails with
-- "permission denied" — then the application role already holds UPDATE and
-- DELETE on `error_events`, and every GRANT below is a no-op.
--
-- The restriction is only real if it is stated as a restriction.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON error_events     FROM ordence_app;
    REVOKE ALL ON web_vital_events FROM ordence_app;

    -- INSERT and SELECT only. No UPDATE, no DELETE — belt and braces
    -- alongside the trigger in Section 2. If the trigger were ever dropped,
    -- this still refuses.
    GRANT SELECT, INSERT ON error_events TO ordence_app;

    -- Vitals are measurements, not evidence, so DELETE is permitted — it is
    -- how a retention sweep run by the application role would work. Still no
    -- UPDATE: there is no legitimate reason to alter a recorded measurement,
    -- and permitting it would let a bad deploy quietly rewrite its own p75.
    GRANT SELECT, INSERT, DELETE ON web_vital_events TO ordence_app;

    GRANT SELECT ON telemetry_daily TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 6 — VERIFICATION
-- ############################################################################
--
-- Every check below prints a row. Read them. A silent success is not the same
-- as a success, and these failures have no other symptom.

-- Check 1 — RLS is enabled AND forced on both tables.
SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS' ELSE '*** FAIL ***' END         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('error_events','web_vital_events')
ORDER BY c.relname;


-- Check 2 — every policy carries a WITH CHECK clause.
--
-- A policy with only USING filters what you can READ but permits INSERTing a
-- row attributed to another tenant. That is a write-side leak and it is easy
-- to miss because reads look correct.
SELECT
  tablename,
  policyname,
  CASE WHEN with_check IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — reads filtered, writes are not ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('error_events','web_vital_events')
ORDER BY tablename;


-- Check 3 — the append-only triggers exist on error_events.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       -- `tgenabled` is PostgreSQL's internal "char" type, not text. Without
       -- the cast this line fails with `operator is not unique: unknown || "char"`.
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'error_events'::regclass
  AND NOT tgisinternal
ORDER BY tgname;


-- Check 4 — ⭐ THE MOST IMPORTANT ROW IN THIS FILE.
--
-- The health view must be security_invoker. Without it, `SELECT * FROM
-- telemetry_daily` run by ANY tenant returns aggregates over EVERY tenant's
-- telemetry, because a view runs as its owner by default and the owner is
-- exempt from nothing but satisfies every policy.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'telemetry_daily'
      AND c.reloptions @> ARRAY['security_invoker=true']
  ) THEN 'PASS: telemetry_daily is evaluated under the caller''s RLS context'
  ELSE  '*** FAIL: telemetry_daily IS NOT security_invoker — it returns '
        'EVERY TENANT''S telemetry to EVERY CALLER ***'
  END AS verdict;


-- Check 5 — the PII guard constraints survived `drizzle-kit push`.
--
-- These are the constraints that make it impossible to store a raw URL — and
-- therefore a record id, and therefore a pointer to a named person — in a
-- column whose name says "pattern". A push that dropped them would be silent.
SELECT
  expected.conname,
  CASE WHEN c.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — constraint missing; raw URLs can be stored ***' END AS verdict
FROM (VALUES
  ('error_events_route_is_pattern'),
  ('error_events_fingerprint_shape'),
  ('error_events_message_bounded'),
  ('error_events_stack_bounded'),
  ('web_vital_events_route_is_pattern'),
  ('web_vital_events_value_sane')
) AS expected(conname)
LEFT JOIN pg_constraint c ON c.conname = expected.conname
ORDER BY expected.conname;


-- Check 6 — the retention indexes exist.
--
-- Without them the sweep is a sequential scan of the largest tables in the
-- platform, which means it gets run once, takes too long, and is never run
-- again. A retention policy nobody executes is not a retention policy.
SELECT
  expected.indexname,
  CASE WHEN i.indexname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — retention sweep will be a sequential scan ***' END AS verdict
FROM (VALUES
  ('error_events_captured_at_idx'),
  ('web_vital_events_captured_at_idx'),
  ('error_events_fingerprint_idx')
) AS expected(indexname)
LEFT JOIN pg_indexes i
  ON i.indexname = expected.indexname AND i.schemaname = 'public'
ORDER BY expected.indexname;


-- Check 7 — no stored route pattern is actually a URL.
--
-- The CHECK constraint makes such a row impossible to insert, so this should
-- always return zero rows. It is here because a constraint dropped by
-- `drizzle-kit push` would be silent, and because this is the query that
-- answers "did we leak record ids into telemetry?" during an audit.
SELECT 'error_events' AS source, id, route_pattern,
       '*** FAIL — a raw URL is stored in a pattern column ***' AS verdict
FROM error_events
WHERE route_pattern LIKE '%?%' OR route_pattern LIKE '%://%'
UNION ALL
SELECT 'web_vital_events', id, route_pattern,
       '*** FAIL — a raw URL is stored in a pattern column ***'
FROM web_vital_events
WHERE route_pattern LIKE '%?%' OR route_pattern LIKE '%://%';
-- (No rows returned = PASS.)


-- Check 8 — no stored message contains an email address.
--
-- The scrubber removes these. This asserts it actually did, over real data,
-- rather than asserting that the unit test passed. If this ever returns a row,
-- the scrubber has a gap and the telemetry tables are in scope for a DPDP
-- erasure request.
SELECT id, left(message, 80) AS message_head,
       '*** FAIL — an email address survived scrubbing ***' AS verdict
FROM error_events
WHERE message ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
LIMIT 20;
-- (No rows returned = PASS.)


-- Check 9 — cardinality sanity.
--
-- Route patterns are supposed to be a BOUNDED set the size of the app's route
-- table. A count in the thousands means the scrubber is letting something
-- variable through, and the bill and the query planner will both notice
-- before a human does.
SELECT
  count(DISTINCT route_pattern) AS distinct_route_patterns,
  CASE WHEN count(DISTINCT route_pattern) <= 500 THEN 'PASS'
       ELSE '*** FAIL — route pattern cardinality is unbounded; '
            'the scrubber is leaking a variable segment ***' END AS verdict
FROM (
  SELECT route_pattern FROM error_events WHERE route_pattern IS NOT NULL
  UNION ALL
  SELECT route_pattern FROM web_vital_events
) AS all_patterns;
