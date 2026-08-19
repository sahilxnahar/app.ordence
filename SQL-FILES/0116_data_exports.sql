-- ############################################################################
-- 0116 · THE EXPORT LOG — BECAUSE A FULL DATA EXPORT IS A DISCLOSURE
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.72.0-alpha   ·   Migration number: 0116
--
-- ############################################################################
-- 🔴 WHAT IS WRONG TODAY
-- ############################################################################
--
-- The product has three exporters — `server/backup/export.ts`,
-- `server/dpdp/export-service.ts` and `server/tally/exporter.ts` — and NOT ONE
-- OF THEM RECORDS THAT AN EXPORT HAPPENED. The Tally path persists what it
-- SENT, because it must in order to reconcile; the other two hand the customer
-- a file and forget.
--
-- ⚠️ AND WAVE 5 MAKES THAT WORSE BEFORE IT MAKES IT BETTER. It puts an Export
--    button on every register in the product. Yesterday a full dump of the
--    customer master required somebody to go looking; tomorrow it is two
--    clicks from the contacts list.
--
-- 🔴 s.8(5) DPDPA 2023 MAKES THE DATA FIDUCIARY ANSWERABLE FOR PERSONAL DATA
--    IT DISCLOSED. "We do not keep a record of exports" is not an answer to a
--    Board enquiry, and it is not an answer to the customer either — the first
--    question after an employee leaves with a spreadsheet is ALWAYS "what did
--    they take", and today the honest reply is that we cannot tell you.
--
-- ⭐ SO EVERY EXPORT IS A ROW HERE, BEFORE THE BYTES REACH THE BROWSER.
--
-- ############################################################################
-- ⚠️ WHAT THIS TABLE DELIBERATELY DOES NOT HOLD
-- ############################################################################
--
-- THE FILE. Not the bytes, not a copy, not a URL to one. An export log that
-- stores the exports is a second copy of every personal record in the product,
-- sitting in a table nobody thinks of as sensitive, growing forever, and
-- outliving the erasure that was supposed to remove the original.
--
-- It holds WHAT WAS ASKED FOR and WHAT CAME BACK IN SUMMARY: the dataset keys,
-- the format, the row count, the byte count, the filters, and — the column
-- that matters — whether personal data was among it.
--
-- ############################################################################
--
-- ⚠️ NO `BEGIN`/`COMMIT` IN THIS FILE, AND THAT IS DELIBERATE. The Neon
--    browser console sends EVERY STATEMENT ON ITS OWN CONNECTION, so a `BEGIN`
--    opens a transaction that is rolled back the moment the statement returns
--    and every statement after it runs outside it. A migration that LOOKS
--    atomic and is not is worse than one that plainly is not: it is the shape
--    that makes a half-applied schema look impossible.
--
--    Every statement below is independently idempotent — `IF NOT EXISTS`,
--    `CREATE OR REPLACE`, `DROP ... IF EXISTS` before each `CREATE` — so
--    re-running the file after a partial application is safe.
-- ############################################################################

-- ============================================================================
-- ① THE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_exports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    occurred_at    timestamptz NOT NULL DEFAULT now(),

    -- ⭐ WHO. Not nullable and not a name: the user id, so it survives a
    --    rename and resolves through the same join as every other audit.
    --
    -- ⚠️ ON DELETE RESTRICT, NOT CASCADE. Deleting a user must not delete the
    --    record of what they exported. That is the one deletion an
    --    investigation cares about, and CASCADE would make it disappear as a
    --    side effect of offboarding.
    exported_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

    -- ⭐ WHAT WAS ASKED FOR. `subject` is the screen or report; `dataset_keys`
    --    is the machine list, because a report can carry several tables and
    --    "the sales register" does not say whether the line items came too.
    subject        varchar(120) NOT NULL,
    dataset_keys   text[] NOT NULL,

    format         varchar(20) NOT NULL,

    row_count      integer NOT NULL,
    byte_count     bigint  NOT NULL,

    -- 🔴 THE COLUMN THE TABLE EXISTS FOR. True when any exported column was
    --    classified as personal in `lib/dpdp/classification.ts`. This is what
    --    turns a list of downloads into an answer to "what left the building".
    includes_personal_data boolean NOT NULL,

    -- ⚠️ WHICH COLUMNS, BY LABEL. Not the values — see the header — the
    --    HEADINGS. "Name, Mobile, PAN" is what a breach notification under
    --    s.8(6) has to state, and reconstructing it later from a format id and
    --    a date is guesswork.
    personal_columns text[] NOT NULL DEFAULT '{}',

    -- ⭐ WHAT NARROWED IT. The date range, the branch, the status filter. A
    --    row count with no filters beside it cannot be compared to anything.
    filters        jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- ⚠️ WHAT THE FORMAT COULD NOT CARRY. `lib/export/pdf.ts` reports the
    --    characters it could not draw; `lib/export/csv.ts` reports the cells it
    --    had to guard against formula injection. Persisting them is how a
    --    later "the PDF was missing the Hindi names" question has an answer
    --    that is not a shrug.
    notes          text[] NOT NULL DEFAULT '{}',

    outcome        varchar(16) NOT NULL DEFAULT 'delivered',
    failure_reason text,

    -- ⚠️ THE FORMAT LIST IS DUPLICATED BETWEEN HERE AND
    --    `lib/export/registry.ts`, AND THAT IS EXACTLY THE DRIFT THIS
    --    CODEBASE KEEPS FINDING. `scripts/check-export-registry.mjs` parses
    --    both and fails the build when they disagree, so the duplication is
    --    checked rather than trusted. Without that gate, adding a format to
    --    the registry and not here produces an export that is generated,
    --    downloaded, and then fails at the INSERT — the customer has the file
    --    and the log has no record of it, which is the worst of the three
    --    possible outcomes.
    CONSTRAINT data_exports_format_known
        CHECK (format IN ('csv', 'xlsx', 'json', 'pdf', 'docx', 'tally-xml')),

    CONSTRAINT data_exports_outcome_known
        CHECK (outcome IN ('delivered', 'refused', 'failed')),

    CONSTRAINT data_exports_counts_sane
        CHECK (row_count >= 0 AND byte_count >= 0),

    -- ⭐ A FAILURE SAYS WHY. Same discipline as `ai_usage` in 0115 and every
    --    other refusal in this product: an outcome with nothing beside it is a
    --    row nobody can act on.
    CONSTRAINT data_exports_failure_named
        CHECK (outcome = 'delivered' OR failure_reason IS NOT NULL),

    -- 🔴 AND A DELIVERED EXPORT OF PERSONAL DATA MUST NAME THE COLUMNS. The
    --    flag without the list is a smoke alarm with no address on it.
    CONSTRAINT data_exports_personal_columns_present
        CHECK (outcome <> 'delivered'
               OR includes_personal_data = false
               OR cardinality(personal_columns) > 0),

    -- ⚠️ AND A DELIVERED EXPORT NAMES AT LEAST ONE DATASET. An empty array
    --    here is a row that records that something was exported and not what.
    CONSTRAINT data_exports_datasets_named
        CHECK (cardinality(dataset_keys) > 0)
);

COMMENT ON TABLE public.data_exports IS
    'One row per export of workspace data, written before the bytes reach the '
    'browser. Holds what was asked for and a summary of what came back — never '
    'the file. `includes_personal_data` and `personal_columns` are what make '
    'this an answer to s.8(5) DPDPA rather than a download counter.';

-- ⭐ THE QUESTION THIS TABLE EXISTS TO ANSWER, INDEXED: what personal data
--    left this workspace, most recent first.
CREATE INDEX IF NOT EXISTS data_exports_personal_idx
    ON public.data_exports (tenant_id, occurred_at DESC)
 WHERE includes_personal_data;

CREATE INDEX IF NOT EXISTS data_exports_tenant_period_idx
    ON public.data_exports (tenant_id, occurred_at DESC);

-- ⚠️ AND BY PERSON, because "what did this leaver take" is the second
--    question and a scan of the whole table is not an answer to it.
CREATE INDEX IF NOT EXISTS data_exports_actor_idx
    ON public.data_exports (tenant_id, exported_by, occurred_at DESC);


-- ============================================================================
-- ② RLS · THE SAME SHAPE AS EVERY OTHER TENANT TABLE
-- ============================================================================
--
-- ⚠️ FORCE, so the table owner is not exempt either. `check:sql-rls-writes`
--    exists because 0115 shipped a bare UPDATE on a FORCE-RLS table that would
--    have silently updated zero rows in production.

ALTER TABLE public.data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_exports FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_exports_tenant_isolation ON public.data_exports;
CREATE POLICY data_exports_tenant_isolation
    ON public.data_exports
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- ③ 🔴 THE GUARD · APPEND-ONLY, AND THIS ONE MATTERS MORE THAN MOST
-- ============================================================================
--
-- ⚠️ THE EDIT SOMEBODY WANTS TO MAKE TO AN EXPORT LOG IS ALWAYS THE SAME ONE:
--    remove the row recording the export they should not have run. A log that
--    the people it records can edit is not a log.
--
-- ⭐ AND UNLIKE `ai_usage`, THIS ONE HAS NO LEGITIMATE CORRECTION EITHER. A
--    metering row can be wrong because a provider reported wrongly. An export
--    either happened or it did not.

CREATE OR REPLACE FUNCTION public.ordence_guard_data_exports_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
    RAISE EXCEPTION
        'data_exports is append-only. It is the record of what personal data left this workspace, and the row somebody wants to change is always the one recording the export they should not have run. If an entry is wrong, record the correction; do not edit the original.'
        USING ERRCODE = 'raise_exception';
END
$guard$;

DROP TRIGGER IF EXISTS ordence_guard_data_exports_append_only ON public.data_exports;

CREATE TRIGGER ordence_guard_data_exports_append_only
    BEFORE UPDATE OR DELETE ON public.data_exports
    FOR EACH ROW EXECUTE FUNCTION public.ordence_guard_data_exports_append_only();


-- ============================================================================
-- ④ THE VERDICT
-- ============================================================================
--
-- ⚠️ ONE STATEMENT, SINGLE-QUOTED LITERALS. See 0101 for why the console needs
--    this shape.

SELECT
    'SQL 0116 · The export log'                                            AS migration,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'data_exports')       AS table_expect_1,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'data_exports')          AS policy_expect_1,
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'ordence_guard_data_exports_append_only')             AS guard_expect_1,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.data_exports'::regclass
        AND contype = 'c')                                                 AS checks_expect_6,
    (SELECT relforcerowsecurity FROM pg_class
      WHERE oid = 'public.data_exports'::regclass)                         AS force_rls_expect_true;
