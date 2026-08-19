-- ############################################################################
-- 0111 , THE RERA STATUTORY LADDER: WHO RAISED IT, AND WHAT MAKES IT SERVED
-- ############################################################################
--
-- REPO: app.ordence          RUN ORDER: after 0108.          RE-RUNNABLE: yes.
--
-- 🔴 RUN THIS FILE **BEFORE** THE CODE PUSH. Section 4 makes
--    `authorised_permission` NOT NULL WITH NO DEFAULT, which is the whole point
--    of it, and that means the currently deployed build's dunning INSERT is
--    refused from the moment section 4 finishes until Railway serves the new
--    build. That gap is real and it is the safe direction: every send in the
--    window fails loudly with a NOT NULL violation and writes nothing. The
--    other order is not better , the new build names a column the database
--    does not have yet , and it leaves the constraints off while code that
--    assumes them is live. There is no zero-gap ordering in one file.
--
-- ############################################################################
-- PURPOSE , TWO HOLES IN THE TABLE THAT DECIDES A FORFEITURE
-- ############################################################################
--
-- ⭐① THE STRONGEST EVIDENCE GRADE IN THE PRODUCT HAD NO WRITER.
--
--    `lib/receivables/service-evidence.ts` has declared `deemed` since 0098.
--    It is described there with `strength: 3` , the highest , and
--    `supportsEnforcement: true`, which means `noticeHasService()` CLEARS A
--    CANCELLATION on it. The CHECK in 0098 permits it. Grep the tree: nothing
--    writes it. Nothing ever could.
--
--    ⚠️ That is this codebase's own recurring defect , declared, displayed,
--    reachable by nothing , standing in the most expensive room in the
--    product. It is the twelfth instance and the second one inside this table.
--
--    🔴 AND IT IS NOT A DEAD GRADE THAT SHOULD BE DELETED. The commonest way a
--    real chase ends is the allottee REFUSING the registered post. The cover
--    comes back endorsed "refused". Under the agreement's service clause , and
--    under s.27 of the General Clauses Act, 1897 for a properly addressed,
--    prepaid registered letter , that is good service. Without this grade the
--    person recording it has two options: claim `human_recorded` DELIVERY,
--    which is false, or record nothing, which loses a case the developer
--    should win. Both are worse than the grade existing.
--
--    ⭐ SO WHAT THIS FILE ADDS IS THE THING THAT MAKES IT SAFE TO WIRE:
--    `service_basis`, and a CHECK that a `deemed` row without one cannot
--    exist. The difference between lawful deemed service and a tick box
--    wearing the top badge IS the stated basis. Without the column the grade
--    would have been wired as an unexplained assertion by whoever ticked it,
--    at the highest strength the product has.
--
-- ⭐⭐② THE TABLE PROMISED TO RECORD AUTHORITY AND RECORDED IT FOR ONE RUNG.
--
--    `db/schema/receivables.ts` opens the `dunning_events` block with: "WHAT
--    WAS SENT, WHEN, THROUGH WHAT CHANNEL, AND ON WHOSE AUTHORITY." It records
--    authority for rung 4 only , `authorised_by` and `authorised_reason`,
--    required by `dunning_events_cancellation_is_authorised`. For rungs 1, 2
--    and 3 the row says nothing about who raised it or under what right.
--
--    ⚠️ AND THE PER-RUNG PERMISSION RULE LIVED IN ONE TERNARY IN ONE SERVER
--    ACTION. `sendDunningNotice` chose `receivables:warn_cancellation` for a
--    cancellation warning and `receivables:dun` for everything else. That is
--    enough to refuse a request. It is not enough to make the rule TRUE OF THE
--    ROW , a back-fill, an import, or a second write path written next year
--    does not come through that action, and each of them is a route by which a
--    cancellation warning gets recorded as ordinary chasing work with nobody's
--    name on it.
--
--    ⭐ SQL 0027 §6 already enforces the ORDER of the ladder at the database
--    for exactly that reason. This file does the same for its AUTHORITY.
--
-- ############################################################################
-- ⭐ HOW HISTORY IS MARKED , NO DML, AGAIN, AND FOR THE SAME REASON AS 0098
-- ############################################################################
--
-- `authorised_permission` is added `NOT NULL DEFAULT 'legacy_unrecorded'` and
-- the default is dropped by the NEXT statement. The ADD COLUMN fills every
-- pre-existing row at DDL time; the DROP DEFAULT makes every future INSERT
-- state its own authority or be refused.
--
-- 🔴 THERE IS NO `UPDATE` IN THIS FILE AND THAT IS DELIBERATE. An UPDATE
--    against a FORCE ROW LEVEL SECURITY table is the failure mode 0091 and
--    0092 both hit; and inventing an authority for a row raised two years ago
--    would be the same crime 0098 refused to commit with `dispatched_at`.
--    `legacy_unrecorded` is not "unknown". It is "this system never recorded
--    it", which is a different sentence, and it is the one the person about to
--    cancel needs to read.
--
-- ⚠️ A ROW INSERTED IN THE MILLISECONDS BETWEEN THOSE TWO STATEMENTS is graded
--    `legacy_unrecorded` rather than carrying its real key. It understates,
--    never overstates: `cancellationServiceFinding` then names that rung as
--    one whose authority this system cannot show. The race can only ever make
--    the file look weaker than it is, which is the only kind worth having in
--    this table.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Migrations here are PASTED INTO THE NEON BROWSER CONSOLE, which sends each
-- statement on its own connection turn. `BEGIN` buys no atomicity across that
-- boundary , it only makes a half-applied file look clean, which is how 0091
-- applied halfway while reporting success. `SET LOCAL app.platform_scope` on
-- its own line reports "executed successfully" and has evaporated before the
-- next statement runs. Neither appears below. Every statement is independently
-- idempotent and the file is safe to re-run from the top after a failure at
-- any point.
--
-- 🔴 `psql -f` DOES NOT REPRODUCE THAT FAILURE MODE, because it sends the whole
--    file on one connection. This file was verified by replaying it statement
--    by statement, each on a fresh connection, against a throwaway PostgreSQL
--    16 , twice, to prove re-runnability , and its refusals were exercised as
--    a NON-SUPERUSER role, because a drill run as `postgres` passes every
--    refusal test and proves nothing.
--
-- 🔴 RLS: `dunning_events` has been tenant scoped, ENABLE and FORCE ROW LEVEL
--    SECURITY, with a policy naming `app_current_tenant_id()`, since 0027 §5
--    and §6. This file adds columns to that table and creates NO new table, so
--    it introduces no new isolation surface. Section 7 re-asserts the posture
--    anyway, so a database that lost it to a `drizzle-kit push` is repaired by
--    re-running this file.
--
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops row-level security policies on
--    275 tables, silently.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If any later section refuses, this row is still on your screen. It tells you
-- how many rungs are about to be marked as having no recorded authority, and
-- how many of those are cancellation warnings , the rung where the answer to
-- "on whose authority" is the question a hearing actually asks.
-- ============================================================================

SELECT
    '0111 · diagnostic'                                          AS finding,
    current_user                                                 AS running_as,
    to_regclass('public.dunning_events')     IS NOT NULL         AS dunning_events_present,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name = 'authorised_permission')               AS already_applied,
    COALESCE((SELECT count(*) FROM public.dunning_events), 0)    AS rungs_on_file,
    COALESCE((SELECT count(*) FROM public.dunning_events
               WHERE stage = 'cancellation_warning'), 0)         AS cancellation_warnings_on_file,
    COALESCE((SELECT count(*) FROM public.dunning_events
               WHERE service_evidence = 'deemed'), 0)            AS rows_already_claiming_deemed_expect_0;


-- ============================================================================
-- SECTION 2 · THE BASIS A DEEMING RESTS ON
-- ============================================================================
-- ⚠️ NOT VALIDATED, AND THAT IS NOT LAZINESS. A refused RPAD, a "not claimed"
--    endorsement and a delivery to the address named in the agreement are
--    three different arguments citing three different things. A regex over
--    them would refuse the real ones, which is how a legally correct record
--    ends up being kept outside the system.
-- ============================================================================

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS service_basis varchar(400);

COMMENT ON COLUMN public.dunning_events.service_basis IS
    'The clause of the agreement, or the section, that makes a DEEMED service good service. Required for service_evidence = ''deemed'' by dunning_events_deemed_states_its_basis. Null on every other grade: a dispatch does not rest on a legal fiction.';


-- ============================================================================
-- SECTION 3 · ⭐⭐ THE CHECK THAT MADE `deemed` SAFE TO WIRE AT ALL
-- ============================================================================
-- ⚠️ SAME SHAPE AS `dunning_events_human_record_names_a_person`, ONE FIELD
--    STRICTER, BECAUSE THE GRADE IS ONE STEP STRONGER. `deemed` outranks every
--    other grade and no machine ever touches it. So it names the person, says
--    when, carries a reference somebody can look up, AND states in words which
--    clause or section makes it good service.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_deemed_states_its_basis') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_deemed_states_its_basis
            CHECK (service_evidence <> 'deemed'
                OR (service_recorded_by IS NOT NULL
                    AND service_recorded_at IS NOT NULL
                    AND served_at IS NOT NULL
                    AND btrim(coalesce(service_reference, '')) <> ''
                    AND btrim(coalesce(service_basis, '')) <> ''));
    END IF;
END $$;


-- ============================================================================
-- SECTION 4 · 🔴🔴 THE AUTHORITY COLUMN · TWO STATEMENTS, NO DML
-- ============================================================================
-- Statement one fills three years of history with 'legacy_unrecorded' as part
-- of the ADD COLUMN itself. Statement two removes the default so that every
-- row written from now on must state its own authority or be refused.
--
-- 🔴 IT IS THE SECOND STATEMENT THAT DOES THE WORK. With the default left in
--    place this column would be a field the code happens to fill , which is
--    what `valuationMethod` and `bank_accounts.reconciled_to` both were.
-- ============================================================================

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS authorised_permission varchar(60) NOT NULL DEFAULT 'legacy_unrecorded';

ALTER TABLE public.dunning_events
    ALTER COLUMN authorised_permission DROP DEFAULT;

COMMENT ON COLUMN public.dunning_events.authorised_permission IS
    'The permission key this rung was raised under. NOT NULL with NO DEFAULT: a writer that does not state its authority is refused, rather than producing an unattributed notice. ''legacy_unrecorded'' marks every row that predates 0111 and was written by the ADD COLUMN default, never by an UPDATE. See lib/receivables/notice-authority.ts.';


-- ============================================================================
-- SECTION 5 · 🔴🔴 THE PER-RUNG PERMISSION, AS A FACT ABOUT THE ROW
-- ============================================================================
-- ⚠️ THE RULE ALREADY EXISTED, IN A TERNARY, IN ONE SERVER ACTION. One server
--    action is not where rows come from. A back-fill of a year's collection
--    history is both the path with the volume and the path that does not come
--    through it , which is the same sentence SQL 0027 §6 uses about the order
--    of the ladder. Its authority gets the same treatment.
--
-- ⭐ 'legacy_unrecorded' IS PERMITTED FOR ANY RUNG. It is what section 4
--    stamped onto history and it asserts nothing.
--    `cancellationServiceFinding()` names every rung carrying it, so it is
--    reported rather than tolerated. No NEW row can use it: new rows must
--    supply the column, and any value other than the right one for their rung
--    is refused here.
--
-- ⚠️ THE KEY NAMES ARE SPELT OUT RATHER THAN LOOKED UP, AND THAT IS ON
--    PURPOSE. If `receivables:warn_cancellation` is ever renamed, this
--    constraint fails loudly on the next send. A rename of the key that guards
--    a forfeiture SHOULD be loud.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_authority_matches_rung') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_authority_matches_rung
            CHECK (authorised_permission = 'legacy_unrecorded'
                OR (stage = 'cancellation_warning'
                    AND authorised_permission = 'receivables:warn_cancellation')
                OR (stage <> 'cancellation_warning'
                    AND authorised_permission = 'receivables:dun'));
    END IF;
END $$;


-- ============================================================================
-- SECTION 6 · THE INDEX THE LADDER BOARD READS
-- ============================================================================
-- ⭐ PARTIAL, ON THE ROWS SOMEBODY IS ABOUT TO ACT ON. "Which rungs on this
--    workspace's file were raised with nobody's right recorded against them?"
--    is asked once, on the board, with a person waiting , and a question that
--    is slow there gets dropped from the screen for being slow.
-- ============================================================================

CREATE INDEX IF NOT EXISTS dunning_events_unrecorded_authority_idx
    ON public.dunning_events (tenant_id, demand_id)
    WHERE authorised_permission = 'legacy_unrecorded';


-- ============================================================================
-- SECTION 7 · RLS, RE-ASSERTED
-- ============================================================================
-- ⚠️ `dunning_events` HAS BEEN TENANT ISOLATED SINCE 0027 AND THIS FILE ADDS
--    NO NEW TABLE. These are re-assertions, not new policy: they are here so a
--    database that lost its posture to a `drizzle-kit push` is repaired by
--    re-running this file, and so the isolation of the table this migration
--    touches is visible in the file that touches it.
-- ============================================================================

ALTER TABLE public.dunning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dunning_events_tenant_isolation ON public.dunning_events;
CREATE POLICY dunning_events_tenant_isolation ON public.dunning_events
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 8 · VERIFY · READ ONLY
-- ============================================================================
-- ⚠️ `authority_default_expect_null` IS THE ONE TO READ. A non-null default
--    here means section 4's second statement did not run, and the column is
--    then a field the code happens to fill rather than one the database
--    requires , which is the whole difference this file exists to make.
-- ============================================================================

SELECT
    '0111 · verify'                                              AS finding,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name IN ('service_basis','authorised_permission'))  AS new_columns_present_expect_2,
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name = 'authorised_permission')                     AS authority_nullable_expect_NO,
    (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name = 'authorised_permission')                     AS authority_default_expect_null,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.dunning_events'::regclass
        AND conname IN ('dunning_events_deemed_states_its_basis',
                        'dunning_events_authority_matches_rung'))      AS checks_present_expect_2,
    (SELECT count(*) FROM public.dunning_events
      WHERE authorised_permission = 'legacy_unrecorded')               AS rungs_marked_unrecorded_not_rewritten,
    (SELECT count(*) FROM public.dunning_events
      WHERE stage = 'cancellation_warning'
        AND authorised_permission = 'legacy_unrecorded')               AS forfeiture_warnings_with_no_recorded_right,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'dunning_events_unrecorded_authority_idx')     AS index_present_expect_1,
    (SELECT relforcerowsecurity FROM pg_class
      WHERE oid = 'public.dunning_events'::regclass)                   AS force_rls_expect_true;
