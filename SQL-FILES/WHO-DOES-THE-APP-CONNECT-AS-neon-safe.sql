-- =====================================================================
-- WHICH ROLE, AND DOES IT BYPASS RLS  ·  READ ONLY  ·  ONE STATEMENT
-- Repo: app.ordence
-- =====================================================================
--
-- 🔴 WHY THIS IS NOW THE MOST IMPORTANT QUESTION IN THE DATABASE.
--
--    `0092` reported that the role running it, `neondb_owner`, has
--    `rolbypassrls = true`. For that role, EVERY `FORCE ROW LEVEL
--    SECURITY` in this database is decoration. The policies exist, the
--    catalog says they are forced, and the engine skips all of them.
--
--    Tenant isolation in this product is RLS. If the APPLICATION also
--    connects as that role, then isolation is not enforced by the
--    database at all , it is enforced only by every code path
--    remembering to call `withTenant`, forever, with no backstop. One
--    missed call is one customer reading another customer's ledger.
--
--    ⚠️ THIS IS NOT A BUG THAT WOULD SHOW UP IN TESTING. Everything
--       works. Every page loads. The failure mode is silent and it is
--       the one failure this product cannot survive.
--
-- ⚠️ `ordence_app` is the role `0087_hardening_narrow_grants.sql` was
--    written for, and its own header says "the application role the
--    codebase connects as". This tells you whether that is true.
--
-- I am NOT asking for your connection string. Nothing here reveals a
-- password. Send me the grid.
-- =====================================================================

SELECT
    r.rolname                                        AS role_name,
    r.rolcanlogin                                    AS can_log_in,
    r.rolsuper                                       AS is_superuser,
    r.rolbypassrls                                   AS bypasses_rls,
    (r.rolname = current_user)                       AS this_is_the_editor_role,
    CASE
        WHEN NOT r.rolcanlogin
            THEN 'group role, cannot connect, not a concern'
        WHEN r.rolsuper OR r.rolbypassrls
            THEN '🔴 RLS DOES NOT APPLY TO THIS ROLE. If the application connects as this, tenant isolation rests entirely on the code and nothing else.'
        ELSE
            '✅ RLS applies. If the application connects as this, FORCE ROW LEVEL SECURITY is a real backstop.'
    END                                              AS what_it_means,
    CASE
        WHEN r.rolname = 'ordence_app'
            THEN 'this is the role 0087 narrowed grants for, and the one DATABASE_URL should be using'
        WHEN r.rolname = 'neondb_owner'
            THEN 'Neon default owner. Right for the SQL editor and for migrations. Wrong for the application.'
        ELSE ''
    END                                              AS note
FROM pg_roles r
WHERE r.rolcanlogin
ORDER BY r.rolbypassrls DESC, r.rolsuper DESC, r.rolname;
