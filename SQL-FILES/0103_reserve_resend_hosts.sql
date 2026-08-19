-- ############################################################################
-- 0103 , RESERVE THE RESEND MAIL HOSTS
-- ############################################################################
--
-- PURPOSE
-- -------
-- Resend now has DNS under `ordence.com`, and the reserved slug list did not
-- know. This adds the labels before a tenant can claim one.
--
--   updates.ordence.com            verified sending domain   NOT RESERVED
--   send.ordence.com               MX + SPF return path      NOT RESERVED
--   resend._domainkey.ordence.com  DKIM selector             `resend` NOT RESERVED
--
-- ############################################################################
-- THE ONE THAT IS NOT OBVIOUS, AND IS THE REASON THIS FILE EXISTS
-- ############################################################################
--
-- `send` carries only an MX record and a TXT record. Neither is an address
-- record, so it is natural to assume the Railway wildcard `*.ordence.com`
-- still answers an A query for `send.ordence.com`.
--
-- IT DOES NOT.
--
-- A DNS wildcard is used only when the queried name does not exist in the
-- zone AT ALL. Once `send.ordence.com` holds any RRset , an MX is enough ,
-- the name EXISTS, and an A query for it returns NODATA rather than falling
-- through to `*`. RFC 4592 section 2.2.1.
--
-- So a tenant who claimed the slug `send` would get a `tenants` row, a
-- success message, an entitlement grant and a welcome email, and their
-- workspace hostname would resolve to NOTHING. Not to somebody else's
-- server, which at least fails visibly. To nothing.
--
-- ⚠️ This is the `clkmail` failure with the mechanism inverted. There, an
--    explicit CNAME beat the wildcard. Here, records of a COMPLETELY
--    DIFFERENT TYPE suppress the wildcard for the whole name. The lesson
--    generalises further than 0092 stated it: it is not "an explicit address
--    record beats a wildcard", it is "any record at a name removes that name
--    from the wildcard".
--
-- `updates` is the plain case. It is the verified sending domain and holds
-- its own records, so the same suppression applies.
--
-- `resend` is defensive, matching how 0092 treated `clk` and `clk2`. The
-- label sits in a DKIM selector name (`resend._domainkey.ordence.com`) whose
-- parent under the zone is `_domainkey`, not `resend`, so claiming the slug
-- `resend` would not by itself capture the selector. Reserved anyway: the
-- cost is one row and the name is confusing enough in a support conversation
-- to be worth removing from circulation.
--
-- ⭐ THE RULE, RESTATED, BECAUSE IT HAS NOW FIRED TWICE.
--    Every time a vendor is given DNS under `ordence.com`, its labels are
--    reserved in the same change. The reserved list is a mirror of the zone
--    file, and a mirror goes stale silently. Clerk in 0092. Resend here.
--
-- RUN ORDER: after 0102. Idempotent, `ON CONFLICT DO NOTHING`.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DOES ANY EXISTING TENANT ALREADY HOLD ONE · READ ONLY · FIRST
-- ============================================================================
-- Zero rows on a healthy database.
-- ⚠️ If this returns anything, tell me BEFORE touching the row. Changing a
--    slug changes a live hostname, and 0091's retention then blocks the old
--    name for 365 days.
--
-- ⭐ THE DIAGNOSTIC RUNS FIRST ON PURPOSE. If section 2 refuses, you still
--    learn the thing worth learning. A file whose most valuable output sits
--    behind its least certain operation teaches you nothing on the day it
--    breaks.
-- ============================================================================

SELECT
    '0103 · reserved name already in use'  AS finding,
    t.id                                   AS tenant_id,
    t.slug                                 AS stored_slug,
    t.name                                 AS workspace_name,
    t.status                               AS workspace_status,
    'this workspace hostname does not resolve, because Resend DNS suppresses the wildcard at that name'
                                           AS consequence
FROM public.tenants t
WHERE t.slug IN ('updates', 'send', 'resend');


-- ============================================================================
-- SECTION 2 · THE THREE NAMES · ONE STATEMENT, SCOPE AND WRITE TOGETHER
-- ============================================================================
--
-- 🔴 A `DO` BLOCK, NOT `BEGIN; SET LOCAL ...; INSERT;`.
--    `reserved_slugs` carries FORCE ROW LEVEL SECURITY with
--    `WITH CHECK (app_platform_scope())`. In a browser SQL console each
--    statement travels on its own connection, so a `SET LOCAL` issued as its
--    own statement reports success and is gone before the INSERT runs. That
--    cost 0092 three rounds. A `DO` block is one statement, one connection,
--    one transaction, and there is no gap for the setting to be lost in.
-- ============================================================================

DO $reserve$
DECLARE
    v_added integer;
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO public.reserved_slugs (slug, category, reason, added_by) VALUES
        ('updates', 'mail',
         'Resend verified sending domain. Holds its own DNS records, so the name exists in the zone and the Railway wildcard no longer answers address queries for it',
         'migration:0103'),
        ('send', 'mail',
         'Resend return path: MX to feedback-smtp.amazonses.com plus an SPF TXT. Neither is an address record, but any RRset at a name removes that name from the wildcard, so a tenant claiming this slug gets a hostname that resolves to nothing',
         'migration:0103'),
        ('resend', 'mail',
         'DKIM selector label (resend._domainkey). Defensive, as clk and clk2 were in 0092',
         'migration:0103')
    ON CONFLICT (slug) DO NOTHING;

    GET DIAGNOSTICS v_added = ROW_COUNT;
    RAISE NOTICE '0103: % row(s) inserted (0 means already present)', v_added;
END
$reserve$;


-- ============================================================================
-- SECTION 3 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
-- `added_by` tells you whether this run added them or a previous run had.
-- ============================================================================

SELECT
    '0103 · confirmation' AS finding,
    r.slug                AS reserved_slug,
    r.category            AS category,
    r.added_by            AS added_by,
    r.added_at            AS added_at
FROM public.reserved_slugs r
WHERE r.slug IN ('updates', 'send', 'resend')
ORDER BY r.slug;

SELECT
    '0103 · verdict'                              AS finding,
    count(*)                                      AS names_present,
    CASE WHEN count(*) = 3
         THEN 'PASS , all three Resend labels are reserved'
         ELSE 'FAIL , section 2 did not apply, send me the error from its tab'
    END                                           AS verdict,
    (SELECT count(*) FROM public.reserved_slugs)  AS reserved_count_after
FROM public.reserved_slugs r
WHERE r.slug IN ('updates', 'send', 'resend');
