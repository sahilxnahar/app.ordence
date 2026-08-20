-- ############################################################################
-- TRACK B (wave 17) · A COMMENT IN THE DATABASE THAT HAS BECOME FALSE
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: the assembled wave-16 tree   ·   Number: PENDING
--
-- ⚠️ NUMBER PENDING, ON PURPOSE. Track B's assigned block was 0133–0135 and all
--    three are spent. The highest number on the assembled tree is 0159 and
--    Track B has not been assigned a wave-17 number, so this file follows the
--    convention Track D used for the same situation
--    (`TRACK-D-PENDING-NUMBER-security-event-types.sql`): integration renames
--    it to the next free number when it lands.
--
-- ############################################################################
-- 🔴 WHAT IS WRONG
-- ############################################################################
--
-- SQL 0134 created `security_event_stream` and attached a COMMENT saying, in
-- part:
--
--     "...and cannot include withPlatformScope() raises, which are not
--      recorded anywhere — see PATCH-REQUEST-B.md."
--
-- That was true when it was written. `withPlatformScope()` took a mandatory
-- justification of at least ten characters and then discarded it outside
-- development, so every cross-tenant read in the product was unlogged and no
-- view could invent the rows.
--
-- ⭐ TRACK D BUILT THE RECORDER. `lib/security/platform-scope.ts` exports
--    `recordPlatformScopeRaise()` and `withJustifiedPlatformScope()`, and
--    `platform.scope_raised` is now a member of the security vocabulary. Those
--    rows would land in `security_events`, which is branch ① of this view, so
--    the stream needs no functional change to carry them.
--
-- 🔴 AND NOTHING CALLS EITHER FUNCTION YET, SO THE COUNT IS STILL ZERO.
--    Verified by grep against the assembled tree: the only references to
--    `recordPlatformScopeRaise` and `withJustifiedPlatformScope` outside their
--    own module are in `tests/security/platform-scope-justification.test.ts`,
--    and Track D's own report says so — "withJustifiedPlatformScope, which no
--    existing code uses". `tests/ui/security-emission.test.ts` fails on the
--    same fact: "platform.scope_raised reaches a surface → expected false to
--    be true".
--
--    ⚠️ THE DIAGNOSIS HAS CHANGED AND THAT IS WHAT THIS FILE RECORDS. Wave 14
--    said the rows could NEVER exist because nothing recorded them. That is no
--    longer why. The mechanism exists; `db/index.ts#withPlatformScope()` has
--    not been given the one line that calls it (PATCH-REQUEST-B item ⑪a, and
--    Track D's own patch request). "Missing caller" and "missing mechanism"
--    need different work from different people, and a comment that says the
--    second when the truth is the first sends the reader to rebuild something
--    that already exists.
--
-- 🔴 THE COMMENT IS THE PROBLEM EITHER WAY. It is the first thing a reader runs
--    `\d+ security_event_stream` to see, and it tells them a capability they
--    now have does not exist. A stale comment on an evidence view is worse than
--    no comment: it is a documented reason not to look.
--
-- ############################################################################
-- IS THERE DATA LOSS?  No. This file changes one COMMENT and nothing else.
--    The view definition is not touched, so `security_invoker = true` and the
--    six branches are unaffected — and section ② asserts both, because a file
--    that "only changes a comment" is exactly the shape that quietly does more.
--
-- RUN ORDER: after 0134 and after Track D's security-event-types migration.
--    Order relative to the code push does not matter: nothing reads this
--    comment at runtime.
--
-- ⚠️ NO BEGIN/COMMIT. See 0133.
-- ############################################################################


-- ============================================================================
-- ① THE CORRECTION
-- ============================================================================

COMMENT ON VIEW public.security_event_stream IS
    'One shape over the six tables that hold this product''s security facts. security_invoker = true, so a tenant session sees exactly its own rows and a platform-scoped session sees all of them. Deliberately excludes audit_logs.old_value/new_value, which are the customer''s data. ⭐ Cross-tenant read raises CAN now appear here, as security_events rows of type platform.scope_raised: Track D built lib/security/platform-scope.ts to record them. 🔴 The count is still zero, because nothing calls recordPlatformScopeRaise() outside its own tests — db/index.ts#withPlatformScope() still discards its justification. SQL 0134 said these rows could never exist; the mechanism now exists and the caller does not, which is different work for a different person.';


-- ============================================================================
-- ② VERIFY — AND RAISE IF ANYTHING ELSE MOVED
-- ============================================================================

DO $$
DECLARE
    opts    text[];
    viewdef text;
    t       text;
    note    text;
BEGIN
    IF to_regclass('public.security_event_stream') IS NULL THEN
        RAISE EXCEPTION 'TRACK-B COMMENT FIX FAILED: security_event_stream does not exist. Apply SQL 0134 first.';
    END IF;

    -- 🔴 THE PROPERTY 0134 EXISTS TO PROTECT, RE-ASSERTED. A view that lost
    -- security_invoker would execute as its owner, which owns every underlying
    -- table, and hand one tenant another tenant's security events.
    SELECT reloptions INTO opts FROM pg_class
     WHERE oid = 'public.security_event_stream'::regclass;
    IF opts IS NULL OR NOT ('security_invoker=true' = ANY(opts)) THEN
        RAISE EXCEPTION
            'TRACK-B COMMENT FIX FAILED: security_event_stream is no longer security_invoker. Something between 0134 and now replaced the view.'
            USING ERRCODE = '42501';
    END IF;

    SELECT pg_get_viewdef('public.security_event_stream'::regclass, true) INTO viewdef;
    FOREACH t IN ARRAY ARRAY['security_events','audit_logs','permission_denials',
                             'data_exports','platform_impersonation_sessions',
                             'platform_action_log']
    LOOP
        IF position(t IN viewdef) = 0 THEN
            RAISE EXCEPTION
                'TRACK-B COMMENT FIX FAILED: security_event_stream no longer reads %. A stream that silently stopped carrying one of the six is an evidence gap that reads as a quiet month.', t
                USING ERRCODE = '42704';
        END IF;
    END LOOP;

    SELECT obj_description('public.security_event_stream'::regclass, 'pg_class') INTO note;
    IF note IS NULL OR position('platform.scope_raised' IN note) = 0 THEN
        RAISE EXCEPTION 'TRACK-B COMMENT FIX FAILED: the corrected comment did not take.';
    END IF;

    -- ⚠️ A NOTICE, NOT AN EXCEPTION. A tree where Track D's type has not been
    -- added yet is a real intermediate state, and this file is about a comment.
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
          JOIN pg_type ty ON ty.oid = e.enumtypid
         WHERE ty.typname = 'security_event_type' AND e.enumlabel = 'platform.scope_raised'
    ) THEN
        RAISE NOTICE
            'TRACK-B NOTE: platform.scope_raised is not yet in the security_event_type enum, so the corrected comment describes a capability this database does not have YET. Apply Track D''s security-event-types migration.';
    END IF;

    RAISE NOTICE 'TRACK-B PASS: the security_event_stream comment now says that cross-tenant read raises are included; security_invoker and all six branches re-asserted unchanged.';
END
$$;

SELECT
    'TRACK-B · audit stream comment correction'                                  AS migration,
    (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class
      WHERE oid = 'public.security_event_stream'::regclass)                       AS invoker_expect_true,
    (SELECT position('platform.scope_raised' IN
        obj_description('public.security_event_stream'::regclass, 'pg_class')) > 0) AS comment_corrected_expect_true,
    (SELECT count(*) FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'security_event_type'
        AND e.enumlabel = 'platform.scope_raised')                                AS trackd_type_present;
