-- =====================================================================
-- PRE-0091 AUDIT  ·  READ ONLY  ·  SAFE TO RUN IN NEON
-- Repo: app.ordence
-- =====================================================================
--
-- WHAT THIS IS
--   Migration 0091 adds four hard constraints to the tenants table.
--   Every one of them will FAIL, and roll back the whole migration,
--   if even one existing row violates it.
--
--   This file finds those rows FIRST. It reads. It writes nothing.
--   No CREATE, no ALTER, no INSERT, no UPDATE, no DELETE, no DDL.
--
-- HOW TO RUN
--   Paste the whole file into the Neon SQL editor and run it.
--   You will get SIX result tabs. Send me all six.
--
--   There are no \echo commands and no RAISE NOTICE in this file.
--   Both are invisible or unsupported in the Neon editor. Everything
--   that matters comes back as a result ROW.
--
-- HOW TO READ IT
--   Tab 6 is the verdict. If every row in tab 6 says PASS, 0091 will
--   apply cleanly. If any row says BLOCK, do not run 0091 yet, send me
--   tabs 1 to 5 and I will tell you what to do with the offending rows.
-- =====================================================================


-- =====================================================================
-- TAB 1 · UPPERCASE OR MIXED-CASE SLUGS
-- ---------------------------------------------------------------------
-- 0091 adds:  CHECK (slug = lower(slug))
--
-- WHY IT MATTERS BEYOND THE MIGRATION
--   normaliseHost() in lib/tenant.ts lowercases the Host header before
--   matching. So a row stored as "Acme" and a row stored as "acme" BOTH
--   answer to acme.ordence.com, and which one wins is whichever the
--   query happens to return first. The existing unique index compares
--   bytes and does not stop this. This is a live duplicate vector.
-- =====================================================================
SELECT
    'TAB 1 · uppercase slugs'          AS audit_section,
    t.id                               AS tenant_id,
    t.slug                             AS stored_slug,
    lower(t.slug)                      AS would_become,
    t.name                             AS workspace_name,
    t.status                           AS workspace_status,
    -- Is the lowercase form already taken by a DIFFERENT row? If so this
    -- cannot be fixed by a simple UPDATE and needs a decision from you.
    EXISTS (
        SELECT 1 FROM tenants o
        WHERE o.id <> t.id AND o.slug = lower(t.slug)
    )                                  AS lowercase_form_already_taken
FROM tenants t
WHERE t.slug <> lower(t.slug)
ORDER BY t.slug;


-- =====================================================================
-- TAB 2 · SLUGS THAT VIOLATE THE DNS-LABEL SHAPE
-- ---------------------------------------------------------------------
-- 0091 adds:  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$')
--
-- That pattern means: 3 to 63 characters, lowercase alphanumeric and
-- hyphen, no leading or trailing hyphen.
--
-- WHY 3 AND NOT 1
--   provisioning.ts already requires min(3). SLUG_PATTERN in
--   lib/tenant.ts matches a SINGLE character. The two disagree, and
--   one-character labels are exactly the ones worth squatting.
--   0091 settles it at the stricter of the two.
-- =====================================================================
SELECT
    'TAB 2 · shape violations'         AS audit_section,
    t.id                               AS tenant_id,
    t.slug                             AS stored_slug,
    length(t.slug)                     AS slug_length,
    t.name                             AS workspace_name,
    t.status                           AS workspace_status,
    CASE
        WHEN length(t.slug) < 3                     THEN 'shorter than 3 characters'
        WHEN length(t.slug) > 63                    THEN 'longer than 63 characters (not a legal DNS label)'
        WHEN t.slug LIKE '-%'                       THEN 'starts with a hyphen'
        WHEN t.slug LIKE '%-'                       THEN 'ends with a hyphen'
        WHEN t.slug ~ '[^a-z0-9-]'                  THEN 'contains a character outside a-z 0-9 and hyphen'
        ELSE                                             'other'
    END                                AS why_it_fails
FROM tenants t
WHERE t.slug !~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$'
ORDER BY t.slug;


-- =====================================================================
-- TAB 3 · CONFUSABLE-FOLD COLLISIONS
-- ---------------------------------------------------------------------
-- 0091 adds a generated column and a unique index on it:
--
--   slug_fold = translate(replace(replace(replace(slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii')
--
-- Hyphens vanish, "rn" folds to "m", "vv" folds to "w", "0" folds to "o",
-- and "1" and "l" both fold to "i".
-- 0rdence, ordence and 0rdenc... all collapse to one namespace, and so
-- do acme-corp and acmecorp.
--
-- WHY THIS EXISTS
--   Every tenant subdomain carries a certificate we issued and is
--   published in the public certificate transparency log the moment it
--   is issued. A hostname one glyph away from a real customer's, under
--   our own certificate, is the cheapest phishing setup there is.
--
-- WHAT A ROW HERE MEANS
--   Two or more EXISTING tenants already collide under the fold. The
--   unique index will refuse to build. These need a decision, and the
--   decision is not "rename one of them" without reading batch 134
--   first, because renaming a slug changes a live hostname.
-- =====================================================================
SELECT
    'TAB 3 · fold collisions'          AS audit_section,
    f.slug_fold                        AS folded_form,
    count(*)                           AS colliding_rows,
    string_agg(f.slug, ' | ' ORDER BY f.slug)   AS the_slugs,
    string_agg(f.name, ' | ' ORDER BY f.slug)   AS the_workspaces,
    string_agg(f.status, ' | ' ORDER BY f.slug) AS the_statuses
FROM (
    SELECT
        t.id,
        t.slug,
        t.name,
        t.status,
        translate(replace(replace(replace(t.slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii') AS slug_fold
    FROM tenants t
) f
GROUP BY f.slug_fold
HAVING count(*) > 1
ORDER BY count(*) DESC, f.slug_fold;


-- =====================================================================
-- TAB 4 · EXISTING SLUGS THAT SIT IN THE RESERVED UNION
-- ---------------------------------------------------------------------
-- 0091 creates a reserved_slugs table and a BEFORE INSERT OR UPDATE
-- trigger on tenants that refuses any slug in it.
--
-- THE LIST BELOW IS THE UNION OF TWO LISTS THAT HAD DRIFTED APART.
--
--   lib/tenant.ts:30                  decides what RESOLVES  (33 names)
--   server/platform/provisioning.ts:80 decides what is CREATED (34 names)
--
-- They disagree by eight names in each direction. Provisioning can mint
-- assets, ns1, ns2, ftp, clerk, preview, vercel and logout, and then
-- lib/tenant.ts refuses to resolve them, so the workspace provisions
-- successfully and its front door is dead with nothing reporting it.
-- The union is 41 names. 0091 seeds all 41 plus 30 more.
--
-- The extra 30 are the mail, certificate and identity labels. Four of
-- them are load-bearing: postmaster, hostmaster, webmaster and abuse are
-- addresses a certificate authority will accept as proof of domain
-- control. A tenant holding one of those plus its mail is a tenant who
-- can get a certificate issued.
--
-- A row here means an EXISTING tenant already holds a reserved name.
-- The trigger fires on UPDATE as well as INSERT, so that row becomes
-- un-editable until it is either renamed or explicitly grandfathered.
-- =====================================================================
WITH reserved AS (
    SELECT unnest(ARRAY[
        -- union of the two existing lists (41)
        'account','accounts','admin','administrator','api','app','apps','assets',
        'auth','billing','blog','cdn','clerk','console','dashboard','dev','docs',
        'ftp','help','internal','login','logout','mail','ns1','ns2','ordence',
        'platform','portal','preview','root','secure','signin','signup','smtp',
        'staff','staging','static','status','support','system','test','vercel',
        'www',
        -- mail, certificate and identity labels (new in 0091)
        'abuse','autodiscover','ci','dmarc','email','git','gst','hostmaster',
        'idp','imap','invoice','invoices','mx','oauth','pay','payment','payments',
        'pop','postmaster','security','spf','sso','verification','verify','vpn',
        'webmail','webmaster'
    ]) AS name
)
SELECT
    'TAB 4 · reserved names in use'    AS audit_section,
    t.id                               AS tenant_id,
    t.slug                             AS stored_slug,
    t.name                             AS workspace_name,
    t.status                           AS workspace_status,
    t.created_at                       AS created_at,
    CASE
        WHEN t.slug IN ('postmaster','hostmaster','webmaster','abuse')
            THEN 'CRITICAL · certificate-authority validation address'
        WHEN t.slug IN ('admin','administrator','ordence','platform','console','secure','staff','portal')
            THEN 'CRITICAL · impersonates Ordence itself'
        WHEN t.slug IN ('mx','mail','smtp','imap','pop','email','webmail','autodiscover','dmarc','spf')
            THEN 'HIGH · mail-routing label'
        ELSE 'reserved'
    END                                AS severity
FROM tenants t
JOIN reserved r ON r.name = lower(t.slug)
ORDER BY
    CASE
        WHEN t.slug IN ('postmaster','hostmaster','webmaster','abuse') THEN 1
        WHEN t.slug IN ('admin','administrator','ordence','platform','console','secure','staff','portal') THEN 2
        ELSE 3
    END,
    t.slug;


-- =====================================================================
-- TAB 5 · THE WHOLE SLUG POPULATION, FOR CONTEXT
-- ---------------------------------------------------------------------
-- Not a blocker check. This is so I can see what I am actually
-- constraining rather than reasoning about a table I have never seen.
-- If this returns more rows than you want to paste, send me the first
-- 50 and the row count from tab 6.
-- =====================================================================
SELECT
    'TAB 5 · population'               AS audit_section,
    t.slug                             AS stored_slug,
    length(t.slug)                     AS len,
    translate(replace(replace(replace(t.slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii') AS folds_to,
    t.status                           AS workspace_status,
    t.plan_tier                        AS plan_tier,
    (t.clerk_org_id LIKE 'pending:%')  AS still_pending_clerk_org,
    t.custom_domain                    AS custom_domain,
    (t.custom_domain_verified_at IS NOT NULL) AS custom_domain_verified,
    t.created_at                       AS created_at
FROM tenants t
ORDER BY t.created_at;


-- =====================================================================
-- TAB 6 · THE VERDICT
-- ---------------------------------------------------------------------
-- One row per constraint 0091 will add. Read the go_no_go column.
-- If every row says PASS, 0091 applies cleanly.
-- If any row says BLOCK, send me tabs 1 to 5 and stop.
-- =====================================================================
WITH reserved AS (
    SELECT unnest(ARRAY[
        'account','accounts','admin','administrator','api','app','apps','assets',
        'auth','billing','blog','cdn','clerk','console','dashboard','dev','docs',
        'ftp','help','internal','login','logout','mail','ns1','ns2','ordence',
        'platform','portal','preview','root','secure','signin','signup','smtp',
        'staff','staging','static','status','support','system','test','vercel',
        'www','abuse','autodiscover','ci','dmarc','email','git','gst','hostmaster',
        'idp','imap','invoice','invoices','mx','oauth','pay','payment','payments',
        'pop','postmaster','security','spf','sso','verification','verify','vpn',
        'webmail','webmaster'
    ]) AS name
),
counts AS (
    SELECT
        (SELECT count(*) FROM tenants)                                        AS total_tenants,
        (SELECT count(*) FROM tenants WHERE slug <> lower(slug))              AS bad_case,
        (SELECT count(*) FROM tenants
          WHERE slug !~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$')             AS bad_shape,
        (SELECT coalesce(sum(c), 0) FROM (
            SELECT count(*) AS c
            FROM tenants
            GROUP BY translate(replace(replace(replace(slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii')
            HAVING count(*) > 1
         ) x)                                                                 AS fold_collided_rows,
        (SELECT count(*) FROM tenants t
          JOIN reserved r ON r.name = lower(t.slug))                          AS reserved_in_use
)
SELECT * FROM (
    SELECT 1 AS ord,
           'population'                          AS check_name,
           'informational'                       AS constraint_0091,
           total_tenants                         AS offending_rows,
           'INFO'                                AS go_no_go,
           'total rows in tenants'               AS meaning
    FROM counts
    UNION ALL
    SELECT 2,
           'lowercase',
           'CHECK (slug = lower(slug))',
           bad_case,
           CASE WHEN bad_case = 0 THEN 'PASS' ELSE 'BLOCK' END,
           CASE WHEN bad_case = 0
                THEN 'no mixed-case slugs, the CHECK will apply'
                ELSE 'see TAB 1, these rows also answer to the same hostname today' END
    FROM counts
    UNION ALL
    SELECT 3,
           'dns shape',
           'CHECK (slug ~ 3-to-63 dns label)',
           bad_shape,
           CASE WHEN bad_shape = 0 THEN 'PASS' ELSE 'BLOCK' END,
           CASE WHEN bad_shape = 0
                THEN 'every slug is a legal 3-to-63 DNS label'
                ELSE 'see TAB 2' END
    FROM counts
    UNION ALL
    SELECT 4,
           'confusable fold',
           'UNIQUE INDEX tenants_slug_fold_unique',
           fold_collided_rows,
           CASE WHEN fold_collided_rows = 0 THEN 'PASS' ELSE 'BLOCK' END,
           CASE WHEN fold_collided_rows = 0
                THEN 'no two slugs collapse to the same folded form'
                ELSE 'see TAB 3, the unique index will refuse to build' END
    FROM counts
    UNION ALL
    SELECT 5,
           'reserved names',
           'TRIGGER against reserved_slugs (71 names)',
           reserved_in_use,
           CASE WHEN reserved_in_use = 0 THEN 'PASS' ELSE 'BLOCK' END,
           CASE WHEN reserved_in_use = 0
                THEN 'no existing tenant holds a reserved name'
                ELSE 'see TAB 4, those rows become un-editable once the trigger exists' END
    FROM counts
) v
ORDER BY ord;
