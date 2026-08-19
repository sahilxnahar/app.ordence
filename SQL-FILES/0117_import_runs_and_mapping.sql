-- ############################################################################
-- 0117 · A MIGRATION THAT FINISHES, AND A MAPPING SOMEBODY DECIDED
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.73.0-alpha   ·   Migration number: 0117
--
-- ⚠️ NO `BEGIN`/`COMMIT`. The Neon browser console sends every statement on its
--    own connection, so a transaction wrapper would look atomic and not be.
--    Every statement below is independently idempotent.
--
-- ############################################################################
-- 🔴 PROBLEM ONE · THE IMPORTER STOPS AT A THOUSAND ROWS
-- ############################################################################
--
-- `lib/import/plan.ts` says so in its own words, and the reasoning is right:
--
--     "The commit writes one transaction per row (see server/actions/import.ts
--      for why partial success requires that). A thousand of those is slow but
--      finishes; a hundred thousand is a request that times out halfway with
--      some rows written and no report, which is the single worst outcome the
--      whole framework is built to avoid."
--
-- ⚠️ AND THE CONCLUSION IT DRAWS IS THE ONE THIS MIGRATION CHANGES:
--
--     "A customer with more than this has a genuine migration, not a CSV
--      upload, and the honest answer is to say so and split the file."
--
-- 🔴 THAT ANSWER IS FINE FOR A CSV UPLOAD AND IT IS NOT FINE FOR A MIGRATION,
--    WHICH IS THE ENTIRE POINT OF THIS WAVE. A prospect with 40,000 customers
--    being told to cut their file into forty pieces and upload them one at a
--    time, keeping track of which ones worked, is a prospect who stays where
--    they are.
--
-- ⭐ AND THE FIX IS NOT A BIGGER NUMBER. Raising the cap to 100,000 with the
--    same architecture produces exactly the outcome the comment describes: a
--    request that times out halfway with some rows written and no report.
--
-- ⭐⭐⭐ THE FIX IS A RUN. The file stays on the customer's machine, the
--    browser plans it — `planImportRecords` is pure and runs there — and
--    submits it in chunks. This table is what makes the chunks ONE THING:
--    it knows how many rows were expected, how many arrived, which chunks were
--    committed, and whether it finished.
--
-- ⚠️ AND THE FILE IS NEVER STORED SERVER-SIDE. Same argument as `data_exports`
--    in 0116: holding a customer's migration file would be a second copy of
--    their entire master data, in a table nobody thinks of as sensitive,
--    outliving the erasure meant to remove the original.
--
-- ############################################################################
-- 🔴 PROBLEM TWO · A MAPPING NOBODY DECIDED
-- ############################################################################
--
-- Wave 6 lets a model propose which column is which. A proposal that is acted
-- on and not recorded is indistinguishable afterwards from a person's decision,
-- and the question that gets asked six months later is always the same one:
-- "who decided that the GSTIN column was column F?"
--
-- `import_mapping_proposals` answers it: what was proposed, by what, with what
-- confidence, whether a human confirmed it, and whether it changed.
--
-- ############################################################################

-- ============================================================================
-- ① THE WORKSPACE'S POSITION ON AUTOMATIC IMPORT
-- ============================================================================
--
-- ⭐ TWO VALUES, AND THE DEFAULT IS THE CAUTIOUS ONE:
--
--   propose_only          🔴 THE DEFAULT. Nothing is ever written without a
--                         person confirming the mapping.
--   auto_above_threshold  Opt-in. A file whose every required column matched
--                         at 90% confidence or above goes straight through.
--
-- ⚠️ THE COLUMN IS ADDED NULLABLE, BACKFILLED, DEFAULTED AND *THEN* MADE NOT
--    NULL — the ordering 0115 established. And unlike 0115 there is no
--    grandfathering dilemma here, because the safe value and the existing
--    behaviour are the same value.
--
-- 🔴 THE UPDATE RUNS INSIDE A `DO` BLOCK WITH A PLATFORM SCOPE. `tenants` has
--    FORCE ROW LEVEL SECURITY. A bare UPDATE affects ZERO ROWS under any role
--    without BYPASSRLS and reports `UPDATE 0` rather than an error — which is
--    the bug `check:sql-rls-writes` caught in 0115's first draft, and the
--    reason DRILL-0115b exists.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS import_auto_commit_policy varchar(24);

DO $backfill$
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    UPDATE public.tenants
       SET import_auto_commit_policy = 'propose_only'
     WHERE import_auto_commit_policy IS NULL;
END
$backfill$;

ALTER TABLE public.tenants
    ALTER COLUMN import_auto_commit_policy SET DEFAULT 'propose_only';

ALTER TABLE public.tenants
    ALTER COLUMN import_auto_commit_policy SET NOT NULL;

ALTER TABLE public.tenants
    DROP CONSTRAINT IF EXISTS tenants_import_policy_known;
ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_import_policy_known
    CHECK (import_auto_commit_policy IN ('propose_only', 'auto_above_threshold'));

COMMENT ON COLUMN public.tenants.import_auto_commit_policy IS
    'Whether a high-confidence import mapping may commit without a person. '
    'Default propose_only. An opening trial balance is never auto-committed '
    'whatever this says — see lib/import/proposal.ts#neverAutoCommit.';


-- ============================================================================
-- ② THE RUN
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.import_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,

    -- ⚠️ RESTRICT, like data_exports.exported_by. Deleting a user must not
    --    delete the record of the migration they ran; that record is what a
    --    later "where did these 40,000 records come from" is answered from.
    started_by     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

    entity_key     varchar(60)  NOT NULL,
    source_format  varchar(20)  NOT NULL,
    -- ⭐ WHAT THEY CALLED THE FILE. Not the file. See the header.
    source_name    varchar(255),
    -- Sheet, for a workbook with several. The wrong tab is a real failure.
    source_sheet   varchar(120),

    duplicate_mode varchar(10)  NOT NULL,

    -- 🔴 DECLARED BY THE BROWSER BEFORE THE FIRST CHUNK, AND COMPARED AT THE
    --    END. Without it a run that lost its last chunk to a closed laptop is
    --    indistinguishable from one that finished, and the customer believes
    --    they migrated 40,000 records when 38,400 arrived.
    expected_rows  integer NOT NULL,

    rows_written   integer NOT NULL DEFAULT 0,
    rows_skipped   integer NOT NULL DEFAULT 0,
    rows_failed    integer NOT NULL DEFAULT 0,

    status         varchar(16) NOT NULL DEFAULT 'running',

    -- ⚠️ SET WHEN THE RUN ENDED WITHOUT ARRIVING. Named, so the screen can say
    --    which chunk it stopped at rather than "failed".
    stopped_reason text,

    CONSTRAINT import_runs_status_known
        CHECK (status IN ('running', 'completed', 'incomplete', 'abandoned')),

    -- ⚠️ THE FORMAT LIST IS DUPLICATED BETWEEN HERE AND
    --    `lib/import/sources/index.ts`, AND `scripts/check-import-sources.mjs`
    --    parses both and fails the build when they disagree. Same discipline
    --    as `data_exports.format` in 0116: a format the reader accepts and
    --    this refuses produces a migration that reads the file, plans it,
    --    writes the rows, and then fails at the run record — leaving the data
    --    imported and no record of where it came from.
    CONSTRAINT import_runs_source_format_known
        CHECK (source_format IN ('csv', 'xlsx', 'json', 'tally-xml')),

    CONSTRAINT import_runs_counts_sane
        CHECK (expected_rows >= 0 AND rows_written >= 0
           AND rows_skipped  >= 0 AND rows_failed  >= 0),

    -- 🔴 A RUN CANNOT REPORT MORE OUTCOMES THAN IT HAD ROWS. An off-by-one in
    --    the chunker would otherwise show as a completed migration of 41,000
    --    rows from a 40,000-row file, and nobody would question a number that
    --    is too big.
    CONSTRAINT import_runs_outcomes_within_expected
        CHECK (rows_written + rows_skipped + rows_failed <= expected_rows),

    -- ⚠️ COMPLETED MEANS EVERY ROW WAS ACCOUNTED FOR. Not "no error occurred".
    CONSTRAINT import_runs_completed_is_complete
        CHECK (status <> 'completed'
               OR rows_written + rows_skipped + rows_failed = expected_rows),

    CONSTRAINT import_runs_finished_has_time
        CHECK ((status = 'running') = (finished_at IS NULL)),

    CONSTRAINT import_runs_stop_named
        CHECK (status NOT IN ('incomplete', 'abandoned') OR stopped_reason IS NOT NULL)
);

COMMENT ON TABLE public.import_runs IS
    'One migration, across however many chunks the browser sent. Holds what '
    'was expected and what arrived, never the file. `status = completed` '
    'requires every expected row to be accounted for, which is what makes '
    '"your migration finished" a claim rather than a hope.';

CREATE INDEX IF NOT EXISTS import_runs_tenant_idx
    ON public.import_runs (tenant_id, started_at DESC);

-- ⭐ THE ONES THAT DID NOT ARRIVE, which is the list somebody actually needs.
CREATE INDEX IF NOT EXISTS import_runs_unfinished_idx
    ON public.import_runs (tenant_id, started_at DESC)
 WHERE status <> 'completed';

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_runs_tenant_isolation ON public.import_runs;
CREATE POLICY import_runs_tenant_isolation
    ON public.import_runs
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ③ 🔴 THE CHUNK · WHAT MAKES A RETRY SAFE
-- ============================================================================
--
-- ⚠️ THE FAILURE THIS EXISTS TO PREVENT IS A DOUBLE-WRITE ON RETRY. A chunk
--    that times out has often already committed. The browser cannot tell the
--    difference between "never arrived" and "arrived and the answer was lost",
--    and both look identical from a laptop that went to sleep.
--
-- ⭐ SO THE CHUNK INDEX IS UNIQUE PER RUN, AND THE INSERT IS THE LOCK. A
--    replayed chunk hits the unique index and is reported as already done
--    rather than written again.
--
-- 🔴 THIS IS BELT TO THE NATURAL-KEY BRACES, NOT INSTEAD OF THEM.
--    `lib/import/types.ts` already requires every entity to declare a natural
--    key so a re-run cannot duplicate. That protects the ROWS. This protects
--    the COUNTS — without it a replayed chunk reports 500 more rows written
--    than exist, and `import_runs_outcomes_within_expected` above then fails
--    the whole run for an arithmetic error rather than a data one.

CREATE TABLE IF NOT EXISTS public.import_run_chunks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    run_id         uuid NOT NULL REFERENCES public.import_runs(id) ON DELETE CASCADE,

    chunk_index    integer NOT NULL,
    row_count      integer NOT NULL,
    rows_written   integer NOT NULL DEFAULT 0,
    rows_skipped   integer NOT NULL DEFAULT 0,
    rows_failed    integer NOT NULL DEFAULT 0,

    committed_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT import_run_chunks_index_sane CHECK (chunk_index >= 0),
    CONSTRAINT import_run_chunks_counts_sane
        CHECK (row_count >= 0 AND rows_written >= 0
           AND rows_skipped >= 0 AND rows_failed >= 0
           AND rows_written + rows_skipped + rows_failed = row_count)
);

-- 🔴 THE IDEMPOTENCY GUARANTEE. See ③'s header.
CREATE UNIQUE INDEX IF NOT EXISTS import_run_chunks_once
    ON public.import_run_chunks (run_id, chunk_index);

CREATE INDEX IF NOT EXISTS import_run_chunks_run_idx
    ON public.import_run_chunks (tenant_id, run_id, chunk_index);

ALTER TABLE public.import_run_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_run_chunks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_run_chunks_tenant_isolation ON public.import_run_chunks;
CREATE POLICY import_run_chunks_tenant_isolation
    ON public.import_run_chunks
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ④ THE MAPPING SOMEBODY DECIDED
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.import_mapping_proposals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    run_id         uuid REFERENCES public.import_runs(id) ON DELETE SET NULL,

    proposed_at    timestamptz NOT NULL DEFAULT now(),
    proposed_for   uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

    entity_key     varchar(60) NOT NULL,
    source_headers text[]      NOT NULL,

    -- ⭐ THE PROPOSAL ITSELF: field → source header, with the basis and the
    --    confidence for each. Stored as sent, so a later reader sees what was
    --    actually put in front of the person rather than a summary of it.
    proposal       jsonb       NOT NULL,

    -- 🔴 THE WEAKEST REQUIRED COLUMN, 0..1, ×1000 as an integer. Not the
    --    average: an average lets nine certain columns carry one guess over
    --    the line, and the guess is the one that puts four hundred PANs in the
    --    GSTIN field.
    confidence_milli integer   NOT NULL,

    -- ⚠️ WAS A MODEL INVOLVED, AND WHOSE KEY PAID FOR IT. 0115 made "whose
    --    credits" answerable for the assistant; a migration is the single
    --    largest AI spend a new workspace generates, so it is answerable here
    --    too.
    used_model     boolean     NOT NULL DEFAULT false,
    model_source   varchar(16),

    -- ⭐⭐ THE COLUMN THE TABLE EXISTS FOR.
    --
    --   proposed   shown to a person, not yet acted on
    --   confirmed  a person looked at it and accepted it as proposed
    --   corrected  a person looked at it and CHANGED it — see corrections
    --   auto       committed without a person, under auto_above_threshold
    --   discarded  the person walked away
    outcome        varchar(16) NOT NULL DEFAULT 'proposed',

    -- ⚠️ WHAT THEY CHANGED. The most valuable column in this table for
    --    improving the mapper, and the only honest source of that information:
    --    every correction is a case the deterministic matcher got wrong.
    corrections    jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT import_mapping_outcome_known
        CHECK (outcome IN ('proposed', 'confirmed', 'corrected', 'auto', 'discarded')),

    CONSTRAINT import_mapping_confidence_range
        CHECK (confidence_milli BETWEEN 0 AND 1000),

    -- 🔴 AN AUTOMATIC COMMIT MUST HAVE CLEARED THE THRESHOLD. This is the
    --    database refusing to hold a record that contradicts
    --    `lib/import/proposal.ts#AUTO_COMMIT_THRESHOLD`. If the two ever
    --    disagree, the write fails loudly here rather than the log quietly
    --    recording an auto-commit that the code says was impossible.
    CONSTRAINT import_mapping_auto_cleared_threshold
        CHECK (outcome <> 'auto' OR confidence_milli >= 900),

    -- ⚠️ A CORRECTION IS NOT A CORRECTION WITH NOTHING IN IT.
    CONSTRAINT import_mapping_corrected_has_corrections
        CHECK (outcome <> 'corrected' OR corrections <> '{}'::jsonb),

    CONSTRAINT import_mapping_model_source_known
        CHECK (model_source IS NULL OR model_source IN ('platform', 'tenant')),

    -- ⭐ AND A MODEL WAS EITHER USED, WITH A KEY, OR NOT USED AT ALL.
    CONSTRAINT import_mapping_model_pair
        CHECK (used_model = (model_source IS NOT NULL))
);

COMMENT ON TABLE public.import_mapping_proposals IS
    'What Ordence proposed a customer''s columns meant, how sure it was, '
    'whether a model was involved and on whose key, and what the person '
    'changed. `corrections` is the only honest record of where the mapper is '
    'wrong.';

CREATE INDEX IF NOT EXISTS import_mapping_tenant_idx
    ON public.import_mapping_proposals (tenant_id, proposed_at DESC);

-- ⭐ THE ONES A PERSON CORRECTED — the improvement backlog.
CREATE INDEX IF NOT EXISTS import_mapping_corrected_idx
    ON public.import_mapping_proposals (tenant_id, proposed_at DESC)
 WHERE outcome = 'corrected';

ALTER TABLE public.import_mapping_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_mapping_proposals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_mapping_tenant_isolation ON public.import_mapping_proposals;
CREATE POLICY import_mapping_tenant_isolation
    ON public.import_mapping_proposals
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ⑤ 🔴 THE GUARD · A COMMITTED CHUNK IS A FACT
-- ============================================================================
--
-- ⚠️ EDITING A CHUNK'S COUNTS IS HOW A RUN THAT LOST 1,600 ROWS BECOMES A RUN
--    THAT REPORTS COMPLETED. The run row itself is updatable — it has to be,
--    the totals accumulate — but the evidence underneath it is not.

CREATE OR REPLACE FUNCTION public.ordence_guard_import_chunks_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
    RAISE EXCEPTION
        'import_run_chunks is append-only. Each row is the evidence that a chunk of a migration was committed and what it did. Editing one is how a run that lost rows becomes a run that reports as completed. If a chunk needs re-running, run it: the unique index on (run_id, chunk_index) makes that safe.'
        USING ERRCODE = 'raise_exception';
END
$guard$;

DROP TRIGGER IF EXISTS ordence_guard_import_chunks_append_only ON public.import_run_chunks;

CREATE TRIGGER ordence_guard_import_chunks_append_only
    BEFORE UPDATE OR DELETE ON public.import_run_chunks
    FOR EACH ROW EXECUTE FUNCTION public.ordence_guard_import_chunks_append_only();


-- ============================================================================
-- ⑥ THE VERDICT
-- ============================================================================

SELECT
    'SQL 0117 · Import runs and mapping proposals'                          AS migration,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name = 'import_auto_commit_policy')                      AS policy_column_expect_1,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('import_runs', 'import_run_chunks',
                           'import_mapping_proposals'))                     AS tables_expect_3,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('import_runs', 'import_run_chunks',
                          'import_mapping_proposals'))                      AS policies_expect_3,
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'ordence_guard_import_chunks_append_only')             AS guard_expect_1,
    (SELECT count(*) FROM public.tenants
      WHERE import_auto_commit_policy = 'auto_above_threshold')             AS workspaces_importing_automatically;
