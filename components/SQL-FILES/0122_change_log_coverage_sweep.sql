-- ############################################################################
-- 0122 — THE CHANGE LOG ATTACHES ITSELF, AND SAYS SO WHEN IT CANNOT
--        (Infra wave 12 / v1.79.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- Five tenant-scoped tables record no changes at all, so anything written to
-- them can never reach a second machine:
--
--     appraisal_cycles
--     appraisal_subjects
--     reporting_lines
--     appraisal_reviews
--     appraisal_amendments
--
-- They are the appraisal module (0085). A performance review written on the
-- laptop is simply not there on the desktop, and nothing anywhere reports a
-- problem: the sync feed is `change_log`, `change_log` is populated by an
-- AFTER trigger, and a table with no trigger produces no rows, which is
-- indistinguishable from a table nobody edited.
--
-- WHY IT HAPPENED, AND WHY IT WILL HAPPEN AGAIN WITHOUT THIS FILE
-- ---------------------------------------------------------------
-- 0017_change_log.sql attaches the trigger by DISCOVERY: every base table in
-- `public` with a `tenant_id` column, minus a hard-coded exclusion list. That
-- is the right design and its own comment says why:
--
--     ⚠️ DISCOVERED, NOT LISTED. A hand-maintained list is a list somebody
--     forgets to extend, and the omission is silent.
--
-- But the discovery runs ONCE, at the moment 0017 executes. Every table
-- created after 0017 is invisible to it. So each later module file carries a
-- copy of the same DO block naming its own tables , 0018, 0019, 0020, 0021,
-- 0023, 0024, 0025 and on. Seventeen copies of one idea, each maintained by
-- hand, each correct, until 0085 shipped without one.
--
-- ⚠️ THE EXCLUSION LIST ITSELF EXISTS IN FOUR PLACES: 0017's attach block,
-- 0017's verification query, ALL-IN-ONE-SETUP.sql, and
-- tests/security/change-log.test.ts. Four hand-maintained copies of one list
-- is the same shape as the twenty-three gates in three files that infra wave
-- 12 opened with.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Puts the exclusion list in the database, ONCE, as a table with a
--      written reason per row. Every consumer reads it instead of copying it.
--   2. Adds `attach_change_log_triggers()`, which re-runs the discovery. It
--      is idempotent and safe to call from any later migration, which is what
--      a module file should do instead of copying the DO block again.
--   3. Runs it, attaching the five missing triggers.
--   4. RAISES if any tenant-scoped table is still uncovered. 0017 printed a
--      verdict here. A printed verdict is not a control.
--
-- IS THERE DATA LOSS?  No. Triggers and one new platform table. No row in any
-- existing table is read, changed or removed.
--
-- ⚠️ THE FIVE TABLES' EXISTING ROWS ARE NOT BACKFILLED INTO change_log, and
-- deliberately so. `change_log` is a feed of CHANGES with a sequence a client
-- resumes from; synthesising past changes with today's timestamps would tell
-- every already-synced client that five tables were rewritten this morning.
-- The rows are still reachable by a full re-sync, which is the honest way to
-- pick up a table that was never in the feed.
--
-- RUN ORDER
-- ---------
-- After 0085 (which creates the appraisal tables). SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT — a browser SQL console sends each statement on its own
-- connection, so a file-level transaction is decoration. Each statement below
-- is independently idempotent instead.
--
-- RLS
-- ---
-- `change_log_exclusions` is platform data: it describes the SCHEMA, not any
-- tenant's records, it has no `tenant_id`, and every tenant is subject to the
-- same list. It is therefore not under RLS, and the application role gets
-- SELECT only.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — ONE LIST, WITH A REASON PER ROW
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.change_log_exclusions (
  table_name   text PRIMARY KEY,
  reason       text NOT NULL,
  category     text NOT NULL
    CHECK (category IN ('self', 'append-only', 'derived', 'platform')),
  declared_in  text NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.change_log_exclusions IS
  'Tenant-scoped tables that deliberately do NOT record changes. Read by '
  'attach_change_log_triggers(), by 0017''s verification and by '
  'tests/security/change-log.test.ts. Previously four hand-maintained copies '
  'of the same list. A row here is a decision, so `reason` is NOT NULL.';

INSERT INTO public.change_log_exclusions (table_name, reason, category, declared_in)
VALUES
  ('change_log', 'The log must not log itself. Infinite recursion, immediately.', 'self', '0017'),

  ('audit_logs',           'Append-only evidence: the table IS its history.',              'append-only', '0017'),
  ('payment_events',       'Append-only evidence: the table IS its history.',              'append-only', '0017'),
  ('security_events',      'Append-only evidence, and the fastest-growing table here.',    'append-only', '0017'),
  ('error_events',         'Append-only telemetry. Logging it would double the storage.',  'append-only', '0017'),
  ('web_vital_events',     'Append-only telemetry. Logging it would double the storage.',  'append-only', '0017'),
  ('permission_denials',   'Append-only evidence: a refused action is never edited or retracted.', 'append-only', '0017'),
  ('lead_activities',      'Append-only activity stream.',                                 'append-only', '0017'),
  ('contract_signatures',  'Append-only evidence. A signature is never edited.',           'append-only', '0017'),

  ('usage_counters', 'Counters, not content. They move constantly and are derived.', 'derived', '0017'),
  ('usage_levels',   'Counters, not content. They move constantly and are derived.', 'derived', '0017'),

  ('platform_impersonation_sessions',
   'Written by platform staff under withPlatformScope(), where '
   'app_current_tenant_id() is NULL. change_log''s WITH CHECK then refuses the '
   'insert, and because the recorder is an AFTER trigger the refusal takes the '
   'whole statement: closing an impersonation session failed outright. Not a '
   'workaround , a customer''s sync feed is their own records, and "an Ordence '
   'engineer opened a support session" is platform activity that already lives '
   'in platform_action_log.',
   'platform', '0017'),
  ('platform_tenant_flags',   'Platform administration, written outside any tenant context.', 'platform', '0017'),
  ('tenant_support_consents', 'Platform administration, written outside any tenant context.', 'platform', '0017'),
  ('platform_action_log',     'Platform administration, and append-only evidence already.',   'platform', '0017')
ON CONFLICT (table_name) DO NOTHING;


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE SWEEP, AS A FUNCTION A LATER MIGRATION CAN CALL
-- ----------------------------------------------------------------------------
--
-- ⚠️ SECURITY DEFINER with a pinned search_path. Creating a trigger requires
-- ownership of the table, which the application role does not and must not
-- have. EXECUTE is NOT granted to ordence_app: a role that can call this can
-- attach an arbitrary AFTER trigger to any tenant table. It is sealed in
-- scripts/sealed-grants.json for exactly that reason.

CREATE OR REPLACE FUNCTION public.attach_change_log_triggers()
RETURNS TABLE (table_name text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      LEFT JOIN pg_trigger tg
        ON tg.tgname = c.table_name || '_change_log' AND NOT tg.tgisinternal
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND t.table_type   = 'BASE TABLE'
       AND tg.tgname IS NULL
       AND c.table_name NOT IN (SELECT e.table_name FROM change_log_exclusions e)
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION record_change()',
      r.tbl || '_change_log', r.tbl
    );
    table_name := r.tbl;
    action     := 'attached';
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.attach_change_log_triggers() IS
  'Attaches the change_log recorder to every tenant-scoped base table that '
  'does not have it and is not in change_log_exclusions. Idempotent. A module '
  'migration that creates tenant tables should CALL THIS instead of copying '
  '0017''s DO block, which is how the appraisal module (0085) shipped five '
  'tables that never synced.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.attach_change_log_triggers() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.attach_change_log_triggers() FROM ordence_app;
    REVOKE ALL ON change_log_exclusions FROM ordence_app;
    GRANT SELECT ON change_log_exclusions TO ordence_app;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — RUN IT
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attached text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO attached
    FROM attach_change_log_triggers() t;

  IF cardinality(attached) = 0 THEN
    RAISE NOTICE '0122: every tenant-scoped table already recorded its changes.';
  ELSE
    RAISE NOTICE '0122: attached the change recorder to % table(s): %',
      cardinality(attached), array_to_string(attached, ', ');
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY, AND FAIL IF ANYTHING IS STILL UNCOVERED
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT coalesce(array_agg(c.table_name ORDER BY c.table_name), ARRAY[]::text[])
    INTO missing
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    LEFT JOIN pg_trigger tg
      ON tg.tgname = c.table_name || '_change_log' AND NOT tg.tgisinternal
   WHERE c.table_schema = 'public'
     AND c.column_name  = 'tenant_id'
     AND t.table_type   = 'BASE TABLE'
     AND tg.tgname IS NULL
     AND c.table_name NOT IN (SELECT e.table_name FROM change_log_exclusions e);

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      '0122 FAILED: % tenant-scoped table(s) still record no changes: %. '
      'Anything written there can never reach a second machine, and nothing '
      'reports a problem because a table with no trigger produces no rows. '
      'Either attach the recorder or add the table to change_log_exclusions '
      'WITH A REASON.',
      cardinality(missing), array_to_string(missing, ', ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0122 PASS: every tenant-scoped table records its changes, or is excluded '
    'with a stated reason.';
END
$$;
