-- ############################################################################
-- 0092 , RESERVE THE LIVE CLERK HOSTS (Group A follow-up)
-- ############################################################################
--
-- PURPOSE
-- -------
-- 0091 seeded 71 reserved slugs from first principles: impersonation,
-- certificate validation, mail routing, money surfaces, infrastructure. It
-- did NOT look at the DNS zone that actually exists, and the zone has hosts
-- the list did not anticipate.
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
--
--    An explicit CNAME beats a wildcard in DNS resolution. `clkmail` has an
--    explicit CNAME to Clerk's mail service, and the Railway wildcard
--    `*.ordence.com` does not override it. So a tenant that claimed the slug
--    `clkmail` would get a `tenants` row, a success message, an entitlement
--    grant and a welcome email, and its hostname would resolve to Clerk's
--    mail infrastructure forever. The workspace provisions successfully and
--    its front door is somebody else's server.
--
--    That is the SAME failure shape as the two-drifted-lists incident 0091
--    was written for: one half succeeds, the other half was never asked, and
--    the only symptom is a customer who cannot reach their own workspace.
--
--    `clk` and `clk2` are DKIM selectors. A tenant holding either owns a
--    label that sits directly above a record mail receivers use to decide
--    whether mail claiming to be from us is genuine.
--
-- ⭐ THIS IS WHY 0091 MADE THE RESERVED LIST A TABLE RATHER THAN A CHECK
--    CONSTRAINT. Three names, found by reading a DNS page, added by an
--    INSERT. No ALTER, no rewrite, no lock on `tenants`. The design decision
--    paid for itself within a day of shipping.
--
-- ⚠️ THE GENERAL RULE THIS ESTABLISHES, WHICH MATTERS MORE THAN THESE THREE
--    NAMES. Every time a vendor is given a CNAME under `ordence.com`, that
--    label must be reserved in the same change. Clerk today; tomorrow it will
--    be a status page, a docs host, a support desk, a payment provider. The
--    reserved list is not a fixed opinion about names, it is a mirror of the
--    zone file, and it goes stale silently.
--
-- RUN ORDER
-- ---------
-- After 0091. It depends on `reserved_slugs` existing and on nothing else.
--
-- ⚠️ IF ANY TENANT ALREADY HOLDS ONE OF THESE THREE NAMES, the trigger from
--    0091 makes that row un-editable rather than deleting it. Section 2 below
--    reports it as a result row instead of failing, because a migration that
--    refuses to apply teaches you less here than one that applies and tells
--    you what it found.
--
-- IDEMPOTENCE
-- -----------
-- `ON CONFLICT DO NOTHING`. Re-running is a no-op.
--
-- ############################################################################

BEGIN;

-- ============================================================================
-- SECTION 1 , THE THREE NAMES
-- ============================================================================

INSERT INTO public.reserved_slugs (slug, category, reason, added_by) VALUES
    ('clkmail', 'mail',
     'live CNAME to Clerk outbound mail; an explicit CNAME beats the Railway wildcard, so a tenant claiming this gets a workspace whose hostname resolves to Clerk',
     'migration:0092'),
    ('clk', 'mail',
     'DKIM selector label (clk._domainkey); sits above the record mail receivers use to authenticate mail from ordence.com',
     'migration:0092'),
    ('clk2', 'mail',
     'DKIM selector label (clk2._domainkey); rotation partner of clk',
     'migration:0092')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SECTION 2 , DID ANY EXISTING TENANT ALREADY HOLD ONE
-- ============================================================================
--
-- Reported, not enforced. Returns zero rows on a healthy database.
-- ⚠️ If this returns anything, tell me before touching the row: changing a
--    slug changes a live hostname, and the 365-day retention in 0091 means an
--    ill-considered rename blocks the name for a year.
-- ============================================================================

SELECT
    '0092 · reserved name already in use' AS finding,
    t.id                                  AS tenant_id,
    t.slug                                AS stored_slug,
    t.name                                AS workspace_name,
    t.status                              AS workspace_status,
    'this workspace''s hostname resolves to Clerk, not to Ordence' AS consequence
FROM public.tenants t
WHERE t.slug IN ('clkmail', 'clk', 'clk2');

COMMIT;
