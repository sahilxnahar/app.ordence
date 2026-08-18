-- ############################################################################
-- 0092 , RESERVE THE LIVE CLERK HOSTS (Group A follow-up)
-- ############################################################################
--
-- PURPOSE
-- -------
-- 0091 seeded 71 reserved slugs from first principles: impersonation,
-- certificate validation, mail routing, money surfaces, infrastructure. It did
-- NOT look at the DNS zone that actually exists, and the zone has hosts the
-- list did not anticipate.
--
-- The Clerk production instance for `ordence.com` publishes these:
--
--   clerk.ordence.com              frontend API      , already reserved
--   accounts.ordence.com           account portal    , already reserved
--   clkmail.ordence.com            outbound mail     , 🔴 NOT RESERVED
--   clk._domainkey.ordence.com     DKIM selector     , 🔴 `clk` NOT RESERVED
--   clk2._domainkey.ordence.com    DKIM selector     , 🔴 `clk2` NOT RESERVED
--
-- 🔴 WHY THIS IS NOT COSMETIC, AND WHY IT FAILS IN A WAY NOBODY WOULD REPORT.
--    An explicit CNAME beats a wildcard. `clkmail` has a real CNAME to Clerk's
--    mail service and the Railway wildcard `*.ordence.com` does not override
--    it. A tenant claiming `clkmail` would get a `tenants` row, a success
--    message, an entitlement grant and a welcome email, and its hostname would
--    resolve to Clerk's mail infrastructure forever. The workspace provisions
--    successfully and its front door is somebody else's server.
--
--    `clk` and `clk2` are DKIM selectors. A tenant holding either owns the
--    label directly above the record mail receivers use to decide whether mail
--    claiming to be from us is genuine.
--
-- ⚠️ THE GENERAL RULE, WHICH OUTLIVES THESE THREE NAMES. Every time a vendor
--    is given a CNAME under `ordence.com`, its label is reserved in the same
--    change. The reserved list is a mirror of the zone file, and a mirror goes
--    stale silently.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO `SET LOCAL`
-- ############################################################################
--
-- THE FIRST VERSION used a plain INSERT. `0091` puts FORCE ROW LEVEL SECURITY
-- on `reserved_slugs` with `WITH CHECK (app_platform_scope())`, so it was
-- refused:
--
--     ERROR: new row violates row-level security policy for table "reserved_slugs"
--
-- THE SECOND VERSION added `BEGIN; SET LOCAL app.platform_scope = 'on';` and
-- FAILED THE SAME WAY, with the console showing three tabs:
--
--     1: BEGIN   executed successfully
--     2: SET     executed successfully
--     3: ERROR
--
-- ⚠️⚠️ THE BROWSER SQL CONSOLE SENDS EACH STATEMENT SEPARATELY, AND `SET LOCAL`
--      DOES NOT SURVIVE THE TRIP. It reports success, then evaporates before
--      the next statement runs. Nothing warns you. The `SET` tab says
--      "executed successfully" and it is telling the truth about a setting
--      that is already gone.
--
-- 🔴 AND `psql -f file.sql` DOES NOT REPRODUCE THIS, which is exactly how the
--    second version passed its drill. psql sends the whole file on ONE
--    connection, so BEGIN / SET LOCAL / INSERT share a transaction and it
--    applies perfectly from a terminal. **Testing a file the way it is not
--    used proves nothing about the way it is used.** Every migration in this
--    project is pasted into a browser.
--
-- ⭐ THE FIX: THE SETTING AND THE WRITE LIVE IN ONE STATEMENT.
--    A `DO $$ ... $$;` block is a single statement, so it is a single
--    connection and a single transaction by construction. `set_config(name,
--    value, true)` is the PL/pgSQL equivalent of SET LOCAL and is scoped to
--    that block. There is nothing left for the console to lose.
--
-- ⭐ AND THE DIAGNOSTIC RUNS FIRST, DELIBERATELY.
--    Section 1 is a read that cannot fail. If section 3 refuses again, you
--    still learn the thing worth learning. A file whose most valuable output
--    sits behind its least certain operation is a file that teaches you
--    nothing on the day it breaks.
--
-- RUN ORDER: after 0091. Idempotent, `ON CONFLICT DO NOTHING`.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · THE DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
--
-- 🔴 THIS ROW CLOSES A QUESTION ASKED ACROSS NINE SESSIONS.
--
--    `rolbypassrls` is one of three ways row-level security can be silently
--    ineffective. If the connecting role carries it, every FORCE ROW LEVEL
--    SECURITY in this database is decoration for that role and tenant
--    isolation rests entirely on the application never using it. If it does
--    not, the isolation model rests on something the database enforces.
--
--    The fact that the first version of this file was REFUSED is already
--    strong evidence of the good answer. This says it outright.
--
-- `tenant_count` also settles whether 0091's section 6 backfill was a real
-- success or a no-op that never exercised the same policy.
-- ============================================================================

SELECT
    '0092 · diagnostic'                                  AS finding,
    current_user                                         AS running_as,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
                                                         AS bypasses_rls,
    (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)
                                                         AS is_superuser,
    (SELECT count(*) FROM public.tenants)                AS tenant_count,
    (SELECT count(*) FROM public.tenant_slug_history)    AS history_rows,
    (SELECT count(*) FROM public.reserved_slugs)         AS reserved_count_before,
    CASE
        WHEN (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
          OR (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)
            THEN 'This role bypasses RLS. Every FORCE ROW LEVEL SECURITY here is decoration for it, and isolation rests on the application never using this role.'
        ELSE 'This role does NOT bypass RLS. FORCE ROW LEVEL SECURITY is real here, which is the answer we wanted.'
    END                                                  AS what_that_means;


-- ============================================================================
-- SECTION 2 · DOES ANY EXISTING TENANT ALREADY HOLD ONE · READ ONLY
-- ============================================================================
-- Zero rows on a healthy database.
-- ⚠️ If this returns anything, tell me before touching the row. Changing a
--    slug changes a live hostname, and 0091's retention then blocks that name
--    for 365 days.
-- ============================================================================

SELECT
    '0092 · reserved name already in use' AS finding,
    t.id                                  AS tenant_id,
    t.slug                                AS stored_slug,
    t.name                                AS workspace_name,
    t.status                              AS workspace_status,
    'this workspace hostname resolves to Clerk, not to Ordence' AS consequence
FROM public.tenants t
WHERE t.slug IN ('clkmail', 'clk', 'clk2');


-- ============================================================================
-- SECTION 3 · THE THREE NAMES · ONE STATEMENT, SCOPE AND WRITE TOGETHER
-- ============================================================================
--
-- Everything below is a single `DO` block. One statement, one connection, one
-- transaction. `set_config(..., true)` unwinds with the block.
--
-- ⚠️ It reports its result through a RAISE that lands as the statement's
--    notice AND, more usefully, through section 4's count, because notices are
--    invisible in some consoles. Section 4 is the answer you read.
-- ============================================================================

DO $reserve$
DECLARE
    v_added integer;
BEGIN
    -- 🔴 NOT `SET LOCAL`. See the header. `SET LOCAL` issued as its own
    --    statement in a browser console reports success and is gone by the
    --    time the next statement runs. Inside this block it cannot be lost,
    --    because there is no gap for it to be lost in.
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO public.reserved_slugs (slug, category, reason, added_by) VALUES
        ('clkmail', 'mail',
         'live CNAME to Clerk outbound mail, and an explicit CNAME beats the Railway wildcard, so a tenant claiming this gets a workspace whose hostname resolves to Clerk',
         'migration:0092'),
        ('clk', 'mail',
         'DKIM selector label (clk._domainkey). Sits above the record mail receivers use to authenticate mail from ordence.com',
         'migration:0092'),
        ('clk2', 'mail',
         'DKIM selector label (clk2._domainkey). Rotation partner of clk',
         'migration:0092')
    ON CONFLICT (slug) DO NOTHING;

    GET DIAGNOSTICS v_added = ROW_COUNT;
    RAISE NOTICE '0092: % row(s) inserted (0 means already present)', v_added;
END
$reserve$;


-- ============================================================================
-- SECTION 4 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
-- All three must be present. `added_by` tells you whether this run added them
-- or whether a previous run already had.
-- ============================================================================

SELECT
    '0092 · confirmation'                    AS finding,
    r.slug                                   AS reserved_slug,
    r.category                               AS category,
    r.added_by                               AS added_by,
    r.added_at                               AS added_at
FROM public.reserved_slugs r
WHERE r.slug IN ('clkmail', 'clk', 'clk2')
ORDER BY r.slug;

SELECT
    '0092 · verdict'                                     AS finding,
    count(*)                                             AS names_present,
    CASE WHEN count(*) = 3
         THEN 'PASS , all three Clerk hosts are reserved'
         ELSE 'FAIL , section 3 did not apply, send me the error from its tab'
    END                                                  AS verdict,
    (SELECT count(*) FROM public.reserved_slugs)         AS reserved_count_after
FROM public.reserved_slugs r
WHERE r.slug IN ('clkmail', 'clk', 'clk2');
