-- =====================================================================
-- CAN THE APPLICATION SAFELY CONNECT AS `ordence_app`?
-- READ ONLY · INDEPENDENT STATEMENTS · SAFE IN NEON
-- Repo: app.ordence
-- =====================================================================
--
-- 🔴 WHY THIS MATTERS MORE THAN ANYTHING ELSE LEFT ON THE LIST
--
--    `neondb_owner` has `rolbypassrls = true`. For that role the engine
--    SKIPS every one of the 171 `FORCE ROW LEVEL SECURITY` policies in
--    this database. They exist, the catalog says forced, `check:rls`
--    passes because it reads the catalog, and none of them run.
--
--    Tenant isolation in this product IS row-level security. If the
--    application connects as `neondb_owner`, isolation is not enforced by
--    the database at all. It rests on every code path calling
--    `withTenant`, forever, with no backstop, and one missed call is one
--    customer reading another customer's ledger.
--
--    ⭐ `ordence_app` EXISTS and has `rolbypassrls = false`. So the fix is
--       available. The question is whether it is SAFE TODAY.
--
-- ⚠️ DO NOT JUST REPOINT `DATABASE_URL` AND HOPE.
--
--    `0087_hardening_narrow_grants.sql` grants `ordence_app` privileges on
--    a NARROW, DELIBERATE subset of tables, and revokes first. It was
--    never a blanket grant. The only blanket grant in this repo lives in
--    `ALL-IN-ONE-SETUP.sql`, a legacy aggregate that is not in the run
--    order and may never have been applied here.
--
--    So `ordence_app` may not hold SELECT on tables the product reads
--    every second. Switching blind would replace a silent isolation
--    problem with a loud outage, and would teach everybody that the
--    switch is dangerous rather than that the grants were incomplete.
--
--    Sections 2 to 4 measure the gap before anything is changed.
--
-- HOW TO RUN: paste the whole file. Four independent statements, four
-- result tabs. Nothing is modified. Send me tabs 1 and 4 at minimum.
-- =====================================================================


-- =====================================================================
-- TAB 1 · WHO IS ACTUALLY CONNECTED RIGHT NOW
-- ---------------------------------------------------------------------
-- ⭐ THIS ANSWERS THE QUESTION WITHOUT ANYONE READING A CONNECTION
--    STRING. `pg_stat_activity` reports the role each live backend
--    authenticated as. Your application is serving traffic, so its
--    connections are in here.
--
-- ⚠️ If the only row is your own SQL-editor session, the app's compute
--    may have scaled to zero or be pooling elsewhere. Load any page on
--    app.ordence.com and re-run this within a few seconds.
-- =====================================================================

SELECT
    a.usename                                        AS connected_as,
    count(*)                                         AS connections,
    count(*) FILTER (WHERE a.state = 'active')       AS active_now,
    max(a.backend_start)                             AS newest_connection,
    string_agg(DISTINCT coalesce(nullif(a.application_name, ''), '(none)'), ', ')
                                                     AS application_names,
    (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = a.usename)
                                                     AS bypasses_rls,
    CASE
        WHEN a.usename = current_user
            THEN 'this is your SQL editor session, ignore it'
        WHEN (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = a.usename)
            THEN '🔴 A CLIENT IS CONNECTED AS A ROLE THAT BYPASSES RLS. If this is the application, tenant isolation is code-only.'
        ELSE '✅ this client is subject to row-level security'
    END                                              AS verdict
FROM pg_stat_activity a
WHERE a.datname = current_database()
  AND a.usename IS NOT NULL
GROUP BY a.usename
ORDER BY count(*) DESC;


-- =====================================================================
-- TAB 2 · GRANT COVERAGE · HOW MUCH OF THE SCHEMA CAN `ordence_app` USE
-- ---------------------------------------------------------------------
-- The switch is only safe if this role can already do its job.
-- =====================================================================

SELECT
    'grant coverage for ordence_app'                 AS finding,
    count(*)                                         AS tables_total,
    count(*) FILTER (WHERE has_table_privilege('ordence_app', c.oid, 'SELECT'))
                                                     AS can_select,
    count(*) FILTER (WHERE has_table_privilege('ordence_app', c.oid, 'INSERT'))
                                                     AS can_insert,
    count(*) FILTER (WHERE has_table_privilege('ordence_app', c.oid, 'UPDATE'))
                                                     AS can_update,
    count(*) FILTER (WHERE has_table_privilege('ordence_app', c.oid, 'DELETE'))
                                                     AS can_delete,
    count(*) FILTER (WHERE NOT has_table_privilege('ordence_app', c.oid, 'SELECT'))
                                                     AS cannot_even_read,
    CASE
        WHEN count(*) FILTER (WHERE NOT has_table_privilege('ordence_app', c.oid, 'SELECT')) = 0
            THEN '✅ reads every table. A grants migration is probably not needed for SELECT.'
        ELSE '🔴 there are tables this role cannot READ. Switching DATABASE_URL today would break those pages. See TAB 3.'
    END                                              AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';


-- =====================================================================
-- TAB 3 · THE TABLES THAT WOULD BREAK
-- ---------------------------------------------------------------------
-- Named, so the grants migration writes itself. Empty is the good result.
--
-- ⚠️ `needs_write` marks tables the product writes to. A missing SELECT is
--    a broken page. A missing INSERT or UPDATE on a table the product
--    writes is a broken transaction, which is worse, because it fails
--    half-way through something a user believed they had completed.
-- =====================================================================

SELECT
    c.relname                                        AS table_name,
    has_table_privilege('ordence_app', c.oid, 'SELECT') AS can_select,
    has_table_privilege('ordence_app', c.oid, 'INSERT') AS can_insert,
    has_table_privilege('ordence_app', c.oid, 'UPDATE') AS can_update,
    c.relrowsecurity                                 AS rls_enabled,
    c.relforcerowsecurity                            AS rls_forced,
    (EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                AND a.attnum > 0 AND NOT a.attisdropped))
                                                     AS is_tenant_scoped
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT has_table_privilege('ordence_app', c.oid, 'SELECT')
ORDER BY c.relname;


-- =====================================================================
-- TAB 4 · THE VERDICT
-- ---------------------------------------------------------------------
-- One row. Send me this one.
-- =====================================================================

WITH t AS (
    SELECT
        count(*)                                                        AS total,
        count(*) FILTER (WHERE NOT has_table_privilege('ordence_app', c.oid, 'SELECT')) AS no_select,
        count(*) FILTER (WHERE c.relforcerowsecurity)                   AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
),
s AS (
    SELECT
        count(*)                                                        AS seq_total,
        count(*) FILTER (WHERE NOT has_sequence_privilege('ordence_app', c.oid, 'USAGE')) AS seq_no_usage
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
)
SELECT
    'can we switch DATABASE_URL to ordence_app'                         AS question,
    has_schema_privilege('ordence_app', 'public', 'USAGE')              AS has_schema_usage,
    t.total                                                             AS tables,
    t.no_select                                                         AS tables_it_cannot_read,
    t.forced                                                            AS tables_with_forced_rls,
    s.seq_total                                                         AS sequences,
    s.seq_no_usage                                                      AS sequences_it_cannot_use,
    CASE
        WHEN NOT has_schema_privilege('ordence_app', 'public', 'USAGE')
            THEN '🔴 NO. The role cannot even USE the schema. It needs GRANT USAGE ON SCHEMA public first.'
        WHEN t.no_select > 0 OR s.seq_no_usage > 0
            THEN '🔴 NOT YET. Write a grants migration for the objects in TAB 3 first, then switch. Switching now trades a silent isolation gap for a loud outage.'
        ELSE '✅ YES. The role can read everything and use every sequence. Repoint DATABASE_URL, redeploy, and those 171 forced policies become real.'
    END                                                                 AS verdict
FROM t, s;
