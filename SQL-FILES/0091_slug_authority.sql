-- ############################################################################
-- 0091 , SLUG AUTHORITY MOVES INTO THE DATABASE (Group A / batch 132)
-- ############################################################################
--
-- PURPOSE
-- -------
-- A tenant slug is not a display field. It is a public DNS label, it becomes
-- a hostname under our wildcard certificate, and that certificate is
-- published in the public certificate transparency log the moment it is
-- issued. Everything about a slug is therefore adversarial, and until this
-- file the only thing the DATABASE knew about any of it was a single unique
-- index on the raw column.
--
-- Three live defects made that insufficient. All three are in v1.55.0-alpha.
--
--   1. THERE ARE TWO RESERVED-WORD LISTS AND THEY DISAGREE.
--
--        lib/tenant.ts:30                   decides what RESOLVES  (33 names)
--        server/platform/provisioning.ts:80 decides what is CREATED (34 names)
--
--      Eight names in each direction. Provisioning will happily mint
--      `assets`, `ns1`, `ns2`, `ftp`, `clerk`, `preview`, `vercel` and
--      `logout`, and then lib/tenant.ts refuses to resolve them and falls
--      back to { kind: "root" }. The workspace provisions successfully, the
--      operator sees success, and the customer's front door is dead. Nothing
--      reports it, because each half behaves exactly as written.
--
--      The other direction is worse in kind: lib/tenant.ts would resolve
--      `ordence`, `billing`, `console`, `portal`, `secure` and `staff` if
--      anything ever minted them. `ordence.ordence.com` serving a customer's
--      content under our own certificate is the phishing surface the comment
--      in provisioning.ts says the list exists to prevent.
--
--   2. THE MINIMUM LENGTH DISAGREES TOO. provisioning.ts requires 3.
--      SLUG_PATTERN in lib/tenant.ts matches a SINGLE character. One-letter
--      labels are exactly the ones worth squatting.
--
--   3. ⚠️ THE UNIQUE INDEX DOES NOT PREVENT THE DUPLICATE THAT MATTERS.
--      `tenants_slug_unique` compares bytes. normaliseHost() lowercases the
--      Host header before matching. So a row stored as `Acme` and a row
--      stored as `acme` BOTH answer to acme.ordence.com, and which one wins
--      is whichever the query returns first. That is prevented today only by
--      a .toLowerCase() in one Zod schema, in one code path, and self-serve
--      signup is about to become a second code path.
--
-- ⭐ THE PRINCIPLE THIS FILE EXISTS TO ENFORCE
--
--      The availability check is advisory.
--      The unique index is the truth.
--      The insert is the claim.
--
--    Any design where a browser asks "is acme free?", is told yes, and a
--    later insert TRUSTS that answer is a race whose window is the user's
--    typing speed. Two people signing up at the same moment are both told
--    yes. The screen that greys out the button is a MISTAKE GUARD. It stops
--    a typo becoming a support ticket. It is not a boundary and must never
--    be the only refusal.
--
-- RUN ORDER
-- ---------
-- Glob-sorted after 0090. It has real predecessors and cannot float:
--
--   * `tenants` and its `tenants_slug_unique` index (0001).
--   * `app_platform_scope()` (0014, granted to PUBLIC in 0087).
--
-- 🔴 RUN `PRE-0091-AUDIT-neon-safe.sql` FIRST AND READ TAB 6.
--    Every constraint below is a hard one. A single violating row rolls the
--    whole file back and the error names one row and tells you nothing about
--    the other four checks. The audit tells you all five at once, before
--    anything is attempted. It is read-only and cannot change anything.
--
-- 🔴 DO NOT RUN `drizzle-kit push` TO APPLY THIS OR ANYTHING ELSE. It drops
--    RLS policies on 275 tables, silently.
--
-- IDEMPOTENCE
-- -----------
-- Every statement is guarded. Re-running this file is a no-op.
--
-- ############################################################################

BEGIN;


-- ============================================================================
-- SECTION 1 , THE SHAPE OF A SLUG, ENFORCED WHERE NEITHER TYPESCRIPT FILE
--             CAN BYPASS IT
-- ============================================================================
--
-- Two CHECK constraints. Together they settle every disagreement between the
-- two TypeScript files at the stricter reading, in the one layer both of them
-- have to go through.
--
-- ⚠️ `{1,61}` in the middle, not `{0,61}`. That makes 3 the minimum and 63
--    the maximum: 63 is the DNS label limit, 3 is provisioning.ts's rule, and
--    a one-character slug is now impossible rather than merely undesirable.
--
-- ⚠️ The lowercase constraint is the one that closes a LIVE duplicate. Read
--    defect 3 in the header again if it looks cosmetic.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tenants_slug_lowercase'
          AND conrelid = 'public.tenants'::regclass
    ) THEN
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_slug_lowercase
            CHECK (slug = lower(slug));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tenants_slug_shape'
          AND conrelid = 'public.tenants'::regclass
    ) THEN
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_slug_shape
            CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$');
    END IF;
END $$;


-- ============================================================================
-- SECTION 2 , THE RESERVED LIST BECOMES A TABLE
-- ============================================================================
--
-- Not a CHECK with a literal array. A TABLE.
--
-- ⭐ WHY A TABLE AND NOT A CONSTRAINT. This list will grow, and growing it
--    must be an INSERT an operator can do at 2am when somebody reports a
--    lookalike, not a migration plus a deploy plus a build. A control that
--    can only be tightened on a release cycle is a control that will be left
--    loose.
--
-- 🔴 RESERVED WORDS ARE A SECURITY CONTROL, NOT TIDINESS.
--
--    Four of the names added here are load-bearing in a way the original two
--    lists missed entirely: `postmaster`, `hostmaster`, `webmaster` and
--    `abuse` are addresses a CERTIFICATE AUTHORITY will accept as proof of
--    domain control. A tenant holding one of those subdomains, plus mail on
--    it, is a tenant who can have a certificate issued for a name under our
--    domain. That is not a phishing risk, it is a delegation of our identity.
--
--    The mail labels (`mx`, `smtp`, `imap`, `pop`, `autodiscover`, `dmarc`,
--    `spf`, `webmail`, `email`) are next in severity: a tenant owning one
--    can influence how mail for the zone is discovered and handled.
--
-- `_domainkey` is included for completeness even though SLUG_PATTERN can
-- never produce it, because the day someone relaxes the pattern to allow a
-- leading underscore, this row should already be sitting here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reserved_slugs (
    slug        varchar(63) PRIMARY KEY,
    category    varchar(32) NOT NULL,
    reason      text        NOT NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    added_by    text        NOT NULL DEFAULT 'migration:0091',

    CONSTRAINT reserved_slugs_lowercase CHECK (slug = lower(slug))
);

COMMENT ON TABLE public.reserved_slugs IS
    'Slugs no tenant may hold. Enforced by trigger on tenants, mirrored in '
    'lib/slug.ts, and asserted equal to it by a test. A security control: a '
    'tenant holding one of these owns a hostname under our certificate that '
    'either impersonates Ordence or influences mail and certificate issuance.';

-- --- the union of the two lists that had drifted apart (41) ----------------
INSERT INTO public.reserved_slugs (slug, category, reason) VALUES
    ('account',       'identity',    'account surfaces'),
    ('accounts',      'identity',    'account surfaces'),
    ('admin',         'impersonate', 'impersonates the Ordence console'),
    ('administrator', 'impersonate', 'impersonates the Ordence console'),
    ('api',           'infra',       'API host'),
    ('app',           'infra',       'the product host itself'),
    ('apps',          'infra',       'the product host itself'),
    ('assets',        'infra',       'static asset host'),
    ('auth',          'identity',    'authentication surface'),
    ('billing',       'money',       'money surface, high-value impersonation'),
    ('blog',          'marketing',   'marketing surface'),
    ('cdn',           'infra',       'asset delivery host'),
    ('clerk',         'identity',    'our identity provider, impersonation'),
    ('console',       'impersonate', 'impersonates the Ordence console'),
    ('dashboard',     'infra',       'product surface'),
    ('dev',           'infra',       'environment label'),
    ('docs',          'marketing',   'documentation surface'),
    ('ftp',           'infra',       'protocol label'),
    ('help',          'marketing',   'support surface'),
    ('internal',      'impersonate', 'implies Ordence staff'),
    ('login',         'identity',    'authentication surface'),
    ('logout',        'identity',    'authentication surface'),
    ('mail',          'mail',        'mail routing label'),
    ('ns1',           'infra',       'nameserver label'),
    ('ns2',           'infra',       'nameserver label'),
    ('ordence',       'impersonate', 'is our own name'),
    ('platform',      'impersonate', 'impersonates the Ordence console'),
    ('portal',        'impersonate', 'implies an Ordence-operated surface'),
    ('preview',       'infra',       'environment label'),
    ('root',          'impersonate', 'implies privilege'),
    ('secure',        'impersonate', 'implies an Ordence-operated surface'),
    ('signin',        'identity',    'authentication surface'),
    ('signup',        'identity',    'authentication surface'),
    ('smtp',          'mail',        'mail routing label'),
    ('staff',         'impersonate', 'implies Ordence staff'),
    ('staging',       'infra',       'environment label'),
    ('static',        'infra',       'static asset host'),
    ('status',        'infra',       'status page, trusted during an incident'),
    ('support',       'impersonate', 'implies Ordence support, social engineering'),
    ('system',        'impersonate', 'implies privilege'),
    ('test',          'infra',       'environment label'),
    ('vercel',        'infra',       'vendor label'),
    ('www',           'infra',       'the root site itself')
ON CONFLICT (slug) DO NOTHING;

-- --- certificate, mail and identity labels, new in 0091 --------------------
INSERT INTO public.reserved_slugs (slug, category, reason) VALUES
    ('abuse',         'certificate', 'CA-accepted domain-control validation address'),
    ('hostmaster',    'certificate', 'CA-accepted domain-control validation address'),
    ('postmaster',    'certificate', 'CA-accepted domain-control validation address'),
    ('webmaster',     'certificate', 'CA-accepted domain-control validation address'),
    ('_domainkey',    'mail',        'DKIM record label, unreachable today but reserved ahead of any pattern change'),
    ('autodiscover',  'mail',        'mail client autodiscovery'),
    ('dmarc',         'mail',        'mail authentication policy label'),
    ('email',         'mail',        'mail routing label'),
    ('imap',          'mail',        'mail routing label'),
    ('mx',            'mail',        'mail exchange label'),
    ('pop',           'mail',        'mail routing label'),
    ('spf',           'mail',        'mail authentication policy label'),
    ('webmail',       'mail',        'mail routing label'),
    ('ci',            'infra',       'build infrastructure'),
    ('git',           'infra',       'source infrastructure'),
    ('vpn',           'infra',       'network infrastructure'),
    ('idp',           'identity',    'identity provider label'),
    ('oauth',         'identity',    'authorisation surface'),
    ('sso',           'identity',    'authentication surface'),
    ('security',      'impersonate', 'implies an Ordence security surface'),
    ('verification',  'identity',    'implies an Ordence verification surface'),
    ('verify',        'identity',    'implies an Ordence verification surface'),
    ('gst',           'money',       'statutory surface, high-value impersonation in India'),
    ('invoice',       'money',       'money surface, high-value impersonation'),
    ('invoices',      'money',       'money surface, high-value impersonation'),
    ('pay',           'money',       'money surface, high-value impersonation'),
    ('payment',       'money',       'money surface, high-value impersonation'),
    ('payments',      'money',       'money surface, high-value impersonation')
ON CONFLICT (slug) DO NOTHING;

-- --- RLS on the list itself ------------------------------------------------
--
-- ⚠️ THE `USING (true)` ON THE READ POLICY BELOW IS DELIBERATE AND IS NOT THE
--    MISTAKE THAT 0089 FIXED. In 0089 a `FOR ALL ... USING (true)` on
--    `login_lockouts` supplied USING for SELECT as well, and so ERASED the
--    tenant read boundary on a table full of tenant data. This table contains
--    no tenant data and no secret: its contents are shipped to every browser
--    inside lib/slug.ts. Hiding it would achieve nothing and would break the
--    trigger below. Reads are open; WRITES require platform scope, and that
--    is expressed as a SEPARATE policy so the two cannot be confused.
--
--    The two are separate on purpose. A `FOR ALL` policy supplies USING for
--    SELECT, and permissive policies are OR'd. Splitting them means the write
--    policy can never widen the read surface by accident, and the read policy
--    can never widen the write surface.

ALTER TABLE public.reserved_slugs ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.reserved_slugs FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reserved_slugs_read  ON public.reserved_slugs;
DROP POLICY IF EXISTS reserved_slugs_write ON public.reserved_slugs;

CREATE POLICY reserved_slugs_read ON public.reserved_slugs
    FOR SELECT
    USING (true);

CREATE POLICY reserved_slugs_write ON public.reserved_slugs
    FOR ALL
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());


-- ============================================================================
-- SECTION 3 , THE CONFUSABLE FOLD
-- ============================================================================
--
-- ⭐ This is the one control in 0091 that has no equivalent anywhere in the
--    codebase today, and it is the one most worth having.
--
--   slug_fold = translate(replace(replace(replace(slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii')
--
-- Hyphens vanish, `0` folds to `o`, `1` and `l` fold to `i`. So `0rdence` and
-- `ordence` collapse to one namespace, and so do `acme-corp` and `acmecorp`.
-- A UNIQUE index on the folded column means the SECOND of any such pair is
-- refused by the database, in the same statement that tries to claim it.
--
-- WHY IT IS WORTH THE COST
--   Every tenant subdomain carries a certificate WE issued, and the issuance
--   is published in the public CT log within minutes. A hostname one glyph
--   away from a real customer's, holding a valid certificate under our own
--   domain, is the cheapest credible phishing setup that exists. The victim
--   checks the padlock and the padlock is real.
--
-- ⚠️ THE COST IS REAL AND MUST BE STATED, NOT BURIED.
--   This refuses `acme-corp` when `acmecorp` already exists, and those may be
--   two unrelated companies. That is a deliberate trade: the cost of the
--   refusal is one support conversation, the cost of the collision is a
--   customer phished under our certificate.
--
-- ⚠️ AND THE ERROR MESSAGE IS PART OF THE CONTROL.
--   On the PUBLIC signup form the refusal must not name the conflicting
--   workspace, because that turns the form into a lookup tool for which
--   near-miss names are already taken, which is reconnaissance for the exact
--   attack this prevents. The public message is
--       "That name is too similar to an existing workspace. Try adding a word."
--   In the OPERATOR console, where the reader is staff, the conflict may be
--   named. That split lives in lib/slug.ts, not here.
--
-- `translate` and `replace` are both IMMUTABLE, which is what allows a STORED
-- generated column and therefore an index.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.tenants'::regclass
          AND attname  = 'slug_fold'
          AND NOT attisdropped
    ) THEN
        ALTER TABLE public.tenants
            ADD COLUMN slug_fold text
            GENERATED ALWAYS AS (translate(replace(replace(replace(slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii')) STORED;
    END IF;
END $$;

COMMENT ON COLUMN public.tenants.slug_fold IS
    'Confusable-folded slug. Generated, never written by the application. '
    'Unique, so two slugs that differ only by 0/o, 1/l/i or hyphens cannot '
    'both exist. Mirrored by foldSlug() in lib/slug.ts.';

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_fold_unique
    ON public.tenants (slug_fold);


-- ============================================================================
-- SECTION 4 , SLUG HISTORY, AND WHY A RELEASED SLUG IS NOT A FREE NAME
-- ============================================================================
--
-- 🔴 A released slug is a LIVE HOSTNAME. It sits in every bookmark, every
--    emailed invoice link, every WhatsApp message a site engineer sent, every
--    From: header, and permanently in the public certificate transparency
--    log. Re-issuing it to a different company hands that company someone
--    else's inbound traffic, and if mail is ever attached to tenant
--    subdomains, someone else's mail.
--
--    Retention is 365 days and that is the SHORTEST defensible figure, not a
--    generous one. Annual business cycles mean a link sent last March is
--    opened this March.
--
-- The fold is stored here too, so a released `acme-corp` also blocks a fresh
-- claim of `acmecorp`. Without that, the retention rule is trivially defeated
-- by a hyphen.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_slug_history (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    slug            varchar(63) NOT NULL,
    slug_fold       text        NOT NULL,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    released_at     timestamptz,
    release_reason  text,

    CONSTRAINT tenant_slug_history_lowercase CHECK (slug = lower(slug)),
    CONSTRAINT tenant_slug_history_reason_present
        CHECK (released_at IS NULL OR release_reason IS NOT NULL)
);

COMMENT ON TABLE public.tenant_slug_history IS
    'Every slug a tenant has ever held. A row is written on claim and closed '
    'on rename. A slug released within the last 365 days cannot be claimed by '
    'anybody, including the tenant that released it, because the old hostname '
    'is still live in bookmarks, emailed links and the CT log.';

-- ⚠️ The reason column is NOT optional when released_at is set, and that is a
--    CHECK rather than a convention. A rename with no stated reason is the
--    kind of record that is useless in exactly the incident it exists for.

CREATE INDEX IF NOT EXISTS tenant_slug_history_tenant_idx
    ON public.tenant_slug_history (tenant_id);

-- The retention lookups. Both are hot paths in the trigger.
CREATE INDEX IF NOT EXISTS tenant_slug_history_slug_idx
    ON public.tenant_slug_history (slug, released_at);
CREATE INDEX IF NOT EXISTS tenant_slug_history_fold_idx
    ON public.tenant_slug_history (slug_fold, released_at);

-- A tenant may hold a given slug once. Re-claiming your own old slug after
-- the retention window writes a NEW row, so this is on (tenant_id, slug,
-- claimed_at) rather than (tenant_id, slug).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_slug_history_unique
    ON public.tenant_slug_history (tenant_id, slug, claimed_at);

-- --- RLS -------------------------------------------------------------------
--
-- This table carries tenant_id, so check-rls-coverage inspects it and
-- requires: ENABLE, FORCE, a USING clause naming app_current_tenant_id, and
-- app_platform_scope() in WITH CHECK only if the table is named in
-- OPT_IN_PLATFORM_WRITE. It is, and 0091 adds it there (ninth entry).
--
-- WHY IT NEEDS THE OPT-IN MARKER: a rename is a PLATFORM act. It is performed
-- by an operator, inside withPlatformScope(reason, cb), on behalf of a
-- tenant. The tenant's own session must never be able to write its own slug
-- history, because that record is the evidence of what the platform did.

ALTER TABLE public.tenant_slug_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_slug_history FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_slug_history_read  ON public.tenant_slug_history;
DROP POLICY IF EXISTS tenant_slug_history_write ON public.tenant_slug_history;

CREATE POLICY tenant_slug_history_read ON public.tenant_slug_history
    FOR SELECT
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope());

CREATE POLICY tenant_slug_history_write ON public.tenant_slug_history
    FOR ALL
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (app_platform_scope());


-- ============================================================================
-- SECTION 5 , THE GUARD
-- ============================================================================
--
-- 🔴 THIS FUNCTION IS `SECURITY DEFINER` AND THE REASON IS THE WHOLE POINT.
--
--    A guard that reads a table through RLS FAILS OPEN. If the invoking
--    session cannot see the `tenant_slug_history` rows, the lookup returns
--    zero rows, the guard concludes "not recently released", and the claim is
--    ALLOWED. The refusal silently becomes a permission, and nothing in any
--    log says so. A read filter inside a guard is not a smaller guard, it is
--    the absence of one.
--
--    So the function runs as its owner and sees every row.
--
-- ⚠️ SECURITY DEFINER WITHOUT A PINNED search_path IS A PRIVILEGE ESCALATION.
--    An attacker who can create a schema earlier in the search path can
--    shadow `reserved_slugs` with their own empty table and the guard reads
--    that instead. `SET search_path = public, pg_temp` is therefore not
--    hygiene, it is the other half of the SECURITY DEFINER decision. pg_temp
--    is last, deliberately: a temp object must never shadow a real one.
--
-- WHAT IT REFUSES, IN ORDER, EACH WITH A DISTINCT SQLSTATE SO THE
-- APPLICATION CAN MAP IT TO A MESSAGE WITHOUT PARSING ENGLISH:
--
--    P0091  reserved name
--    P0092  released within the retention window (exact slug)
--    P0093  released within the retention window (folded form)
--
-- The exact-unique and fold-unique violations are NOT raised here. They come
-- back as ordinary 23505 unique_violation from the indexes, which is correct:
-- the index is the truth and the trigger must not pretend to be it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ordence_guard_tenant_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fold      text;
    v_reason    text;
    v_released  timestamptz;
BEGIN
    -- Nothing to do when the slug is untouched. This matters: without it,
    -- every unrelated UPDATE to a tenant row pays for three index lookups,
    -- and any tenant grandfathered onto a reserved name becomes un-editable
    -- for reasons that have nothing to do with the edit being attempted.
    IF TG_OP = 'UPDATE' AND NEW.slug IS NOT DISTINCT FROM OLD.slug THEN
        RETURN NEW;
    END IF;

    v_fold := translate(replace(replace(replace(NEW.slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii');

    -- 1 , reserved
    SELECT r.reason INTO v_reason
    FROM public.reserved_slugs r
    WHERE r.slug = NEW.slug;

    IF FOUND THEN
        RAISE EXCEPTION
            'slug "%" is reserved: %', NEW.slug, v_reason
            USING ERRCODE = 'P0091';
    END IF;

    -- 2 , released within the retention window, exact
    SELECT h.released_at INTO v_released
    FROM public.tenant_slug_history h
    WHERE h.slug = NEW.slug
      AND h.released_at IS NOT NULL
      AND h.released_at > now() - interval '365 days'
      AND h.tenant_id IS DISTINCT FROM NEW.id
    ORDER BY h.released_at DESC
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'slug "%" was released on % and is retained until %',
            NEW.slug, v_released::date, (v_released + interval '365 days')::date
            USING ERRCODE = 'P0092';
    END IF;

    -- 3 , released within the retention window, folded
    --
    -- ⚠️ Without this, the retention rule is defeated by a hyphen: release
    --    `acme-corp`, immediately claim `acmecorp`, same hostname to a human
    --    reading an old link.
    SELECT h.released_at INTO v_released
    FROM public.tenant_slug_history h
    WHERE h.slug_fold = v_fold
      AND h.released_at IS NOT NULL
      AND h.released_at > now() - interval '365 days'
      AND h.tenant_id IS DISTINCT FROM NEW.id
    ORDER BY h.released_at DESC
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'slug "%" is too similar to a name released on % and retained until %',
            NEW.slug, v_released::date, (v_released + interval '365 days')::date
            USING ERRCODE = 'P0093';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ordence_guard_tenant_slug() IS
    'Refuses reserved and recently-released tenant slugs. SECURITY DEFINER '
    'because an RLS-filtered lookup inside a guard fails OPEN. search_path is '
    'pinned because SECURITY DEFINER without it is a privilege escalation.';

DROP TRIGGER IF EXISTS ordence_guard_tenant_slug ON public.tenants;

CREATE TRIGGER ordence_guard_tenant_slug
    BEFORE INSERT OR UPDATE OF slug ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.ordence_guard_tenant_slug();

-- ⚠️ `BEFORE INSERT OR UPDATE OF slug` , the column list is load-bearing.
--    Without it the trigger fires on every tenant UPDATE, and the early
--    IS NOT DISTINCT FROM return is the only thing standing between an
--    ordinary settings save and three index lookups. Belt and braces, because
--    the column list alone does not fire on INSERT-with-same-value cases.


-- ============================================================================
-- SECTION 6 , BACKFILL HISTORY FOR EVERY SLUG THAT ALREADY EXISTS
-- ============================================================================
--
-- Without this, `tenant_slug_history` starts empty and the first rename of an
-- existing workspace has nothing to close. The claimed_at is the tenant's
-- created_at, which is the truth as far as it is knowable.
-- ============================================================================

INSERT INTO public.tenant_slug_history (tenant_id, slug, slug_fold, claimed_at)
SELECT
    t.id,
    t.slug,
    translate(replace(replace(replace(t.slug, '-', ''), 'rn', 'm'), 'vv', 'w'), '01l', 'oii'),
    t.created_at
FROM public.tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM public.tenant_slug_history h
    WHERE h.tenant_id = t.id AND h.slug = t.slug
);


-- ============================================================================
-- SECTION 7 , GRANTS
-- ============================================================================
--
-- 0087 narrowed grants deliberately. New tables inherit nothing, so they are
-- named here. `ordence_app` reads both and writes history; it never writes
-- reserved_slugs outside platform scope, which the RLS policy enforces
-- independently of the grant.
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT                         ON public.reserved_slugs      TO ordence_app;
        GRANT INSERT, UPDATE, DELETE         ON public.reserved_slugs      TO ordence_app;
        GRANT SELECT, INSERT, UPDATE         ON public.tenant_slug_history TO ordence_app;
        GRANT EXECUTE ON FUNCTION public.ordence_guard_tenant_slug()       TO ordence_app;
    END IF;
END $$;

-- ⚠️ No DELETE on tenant_slug_history, and that is the point of the table.
--    Retention that can be deleted by the application is retention that will
--    be deleted the first time it is inconvenient. Rows leave only by
--    ON DELETE CASCADE when the tenant itself is removed.

COMMIT;
