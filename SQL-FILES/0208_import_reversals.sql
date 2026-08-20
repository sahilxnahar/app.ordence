-- ############################################################################
-- 0208 — A PARTIAL REVERSAL MUST NOT REPORT SUCCESS
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE SENTENCE THIS FILE EXISTS TO MAKE IMPOSSIBLE
-- ══════════════════════════════════════════════════════════════════════════
-- *"Your migration has been reversed."* — said over a run where 900 of 1,000
-- rows came back and 100 did not.
--
-- The brief states the consequence and it is worth restating in full, because
-- every constraint below is shaped to it: *"The failure mode to design
-- against is a customer who believes their failed migration is gone and
-- starts again on top of it."* They then import the corrected file over a
-- hundred rows that were never removed, in `skip` mode, and those hundred
-- rows are now permanently wrong and permanently invisible — matched by
-- natural key, reported as "already here", and never looked at again.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⭐ TWO CONSTRAINTS, AND THE SECOND ONE IS THE UNUSUAL ONE
-- ══════════════════════════════════════════════════════════════════════════
--   ① `reversed` REQUIRES rows_unreversed = 0.  An ordinary CHECK. It stops
--      the status from lying about the number beside it.
--
--   ② §4 REQUIRES THE FAILURES TO BE NAMED, ONE ROW EACH.  A reversal that
--      says 100 rows could not be reversed and names three of them satisfies
--      ① perfectly. The count is honest and the report is useless: the
--      customer is told a hundred rows are still there and given no way to
--      find them.
--
-- ⚠️ ② IS THE ONE THIS CODEBASE NEEDED. Its characteristic defect is not the
-- outright lie, it is the true summary over an absent detail — the restore
-- script that reported RESTORE COMPLETE while expecting 2 policies against
-- 313 present. A count with nothing behind it is that shape exactly, and a
-- CHECK constraint cannot see it, because the evidence is in another table.
--
-- ############################################################################


-- ############################################################################
-- SECTION 0 — WHAT THE CUSTOMER WAS PROMISED, RECORDED WHEN IT WAS PROMISED
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 A BUG THIS BATCH HAD, FOUND BY THE TEST THAT PROVES THE FOURTH KIND
-- ══════════════════════════════════════════════════════════════════════════
-- `contract.reversal.escapes` is a first-class output, not a debugging aid:
-- the planner shows that sentence to the customer BEFORE the run, and it is
-- the only warning they get that something will survive the undo.
--
-- The first draft of `server/import/reversal.ts` read it from
-- `ALL_IMPORT_ENTITIES` at UNDO time. That is the same mistake
-- `import_row_provenance.reversal_kind` exists to prevent, one member over,
-- and `lib/import/types.ts` already argues it: the contract is declared at
-- DEFINITION time "because at undo time the entity that wrote the row may no
-- longer be the one being asked."
--
-- The consequence is worse than a stale string. A run started when the entity
-- said *"the welcome email has already gone out and removing the records does
-- not un-send it"* would be undone, months later, under an entity whose
-- `escapes` had since been edited to `null` — and the customer would be told
-- that nothing survived.
--
-- ⭐ SO IT IS COPIED ONTO THE RUN AT START, which is the moment it was shown.
-- `import_reversals.escapes` then records what the undo repeated back, and the
-- two can be compared.

ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS reversal_escapes text;

COMMENT ON COLUMN public.import_runs.reversal_escapes IS
    'contract.reversal.escapes AS IT STOOD WHEN THIS RUN WAS STARTED — the '
    'sentence the planner showed the customer before the migration ran. Read by '
    'the undo instead of the registry, because an entity edited between the run '
    'and the undo would otherwise change what the customer is told survived. '
    'NULL for runs that pre-date SQL 0208 and for an entity that promised '
    'nothing escapes. Phase 2, SQL 0208 §0.';


-- ############################################################################
-- SECTION 1 — THE REVERSAL
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.import_reversals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    run_id        uuid NOT NULL,
    entity_key    varchar(60) NOT NULL,

    -- ⚠️ THE KIND THIS REVERSAL ACTED UNDER, copied from the provenance rows
    -- it read rather than from the entity definition, for the reason 0205
    -- gives: an entity's declaration can be edited, and a run written under
    -- the old one must still be undone under the old one.
    kind          varchar(16) NOT NULL,

    requested_at  timestamptz NOT NULL DEFAULT now(),
    requested_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    finished_at   timestamptz,

    status        varchar(10) NOT NULL DEFAULT 'running',

    rows_considered integer NOT NULL DEFAULT 0,
    rows_reversed   integer NOT NULL DEFAULT 0,
    rows_unreversed integer NOT NULL DEFAULT 0,

    -- ⭐ THE SENTENCE THE CUSTOMER WAS SHOWN BEFORE THE RUN, RECORDED AS IT
    -- WAS SHOWN. `contract.reversal.escapes` is a first-class output, not a
    -- debugging aid: it is what the planner puts on screen BEFORE a migration
    -- starts. Storing it here means the answer to "what did we tell them
    -- would survive this?" is the string they actually saw, not the string
    -- that is in the code today.
    escapes       text,

    -- Why a reversal refused to start, or could not finish. NOT NULL whenever
    -- the status is one that owes an explanation — see §2.
    refusal_reason text,

    -- For `reverse-entry`: the compensating record this reversal posted.
    -- Nullable because the other three kinds do not post one.
    reversing_transaction_id uuid,

    CONSTRAINT import_reversals_id_tenant_key UNIQUE (id, tenant_id),

    CONSTRAINT import_reversals_run_same_tenant
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES public.import_runs (id, tenant_id) ON DELETE CASCADE,

    CONSTRAINT import_reversals_kind_known
        CHECK (kind IN ('delete', 'restore-prior', 'reverse-entry', 'irreversible')),

    CONSTRAINT import_reversals_status_known
        CHECK (status IN ('running', 'reversed', 'partial', 'refused', 'failed')),

    CONSTRAINT import_reversals_counts_sane
        CHECK (rows_considered >= 0 AND rows_reversed >= 0 AND rows_unreversed >= 0
               AND rows_reversed + rows_unreversed <= rows_considered),

    -- 🔴 ①. THE HEADLINE. "Reversed" means every row came back.
    CONSTRAINT import_reversals_reversed_is_complete
        CHECK (status <> 'reversed'
               OR (rows_unreversed = 0 AND rows_reversed = rows_considered)),

    -- ⚠️ AND THE OTHER DIRECTION, WHICH IS NOT DECORATION. A reversal that
    -- reverses everything and files itself as `partial` would leave the
    -- customer believing rows are still there when they are not — and would
    -- send support looking for a failure that never happened.
    CONSTRAINT import_reversals_partial_is_partial
        CHECK (status <> 'partial' OR rows_unreversed > 0),

    -- 🔴 `irreversible` NEVER REVERSES ANYTHING. Its only lawful ends are
    -- still-running and refused. A row here saying kind = 'irreversible',
    -- status = 'reversed' would be the product claiming it un-sent an email.
    CONSTRAINT import_reversals_irreversible_refuses
        CHECK (kind <> 'irreversible'
               OR (status IN ('running', 'refused') AND rows_reversed = 0)),

    -- Anything that did not simply work owes a sentence.
    CONSTRAINT import_reversals_explained
        CHECK (status NOT IN ('refused', 'failed') OR refusal_reason IS NOT NULL),

    CONSTRAINT import_reversals_finished_has_time
        CHECK ((status = 'running') = (finished_at IS NULL)),

    CONSTRAINT import_reversals_reversing_entry_kind
        CHECK (reversing_transaction_id IS NULL OR kind = 'reverse-entry')
);

COMMENT ON TABLE public.import_reversals IS
    'One attempt to undo one import run. `reversed` is constrained to mean '
    'every row came back; `partial` is constrained to mean at least one did '
    'not, and §4 requires each of those to be named in '
    'import_reversal_failures. A customer who believes their failed migration '
    'is gone will start again on top of it. Phase 2, SQL 0208.';

COMMENT ON COLUMN public.import_reversals.escapes IS
    'contract.reversal.escapes as it was shown to the customer before the run. '
    'Stored rather than re-read so that "what did we tell them would survive '
    'this?" is answered with the sentence they saw.';

CREATE INDEX IF NOT EXISTS import_reversals_run_idx
    ON public.import_reversals (tenant_id, run_id, requested_at);

-- ⚠️ ONE LIVE ATTEMPT PER RUN. The undo button is a button, and a customer
-- watching nothing happen presses it again. Two concurrent reversals of one
-- run would each read the same unreversed provenance rows and each try to
-- delete the same destination row; the loser records a failure against a row
-- that was reversed perfectly well, and the report names rows that are gone.
DROP INDEX IF EXISTS import_reversals_one_live_per_run;
CREATE UNIQUE INDEX import_reversals_one_live_per_run
    ON public.import_reversals (run_id)
    WHERE status = 'running';

-- ⚠️ AND ONE SUCCESS. A second reversal after a PARTIAL one is the retry the
-- customer is told to make, and must stay possible. A second reversal after a
-- complete one has nothing to do and would report zero rows considered, which
-- reads like a failure.
DROP INDEX IF EXISTS import_reversals_one_success_per_run;
CREATE UNIQUE INDEX import_reversals_one_success_per_run
    ON public.import_reversals (run_id)
    WHERE status = 'reversed';


-- ############################################################################
-- SECTION 2 — WHAT COULD NOT BE REVERSED, AND WHAT BLOCKED IT
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.import_reversal_failures (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    reversal_id   uuid NOT NULL,

    -- ⚠️ NULLABLE, AND THE NULL CASE IS REAL. A reversal can fail for the
    -- whole run rather than per row — the entity is gone from the registry,
    -- the destination table has been dropped. That is one failure with no
    -- provenance row behind it, and forcing a fake one would put a row id in
    -- the report that does not exist.
    provenance_id uuid,

    target_table  varchar(63),
    target_id     uuid,
    input_row_number integer,

    -- 🔴 THE COLUMN THIS TABLE EXISTS FOR. "Row 412, invoice INV-0412: a
    -- payment has been recorded against it since the import." Not "failed".
    blocked_by    text NOT NULL,

    -- The database's own answer where there was one. `42501` and `23503` send
    -- support to two completely different places.
    sqlstate      varchar(5),

    recorded_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT import_reversal_failures_reversal_same_tenant
        FOREIGN KEY (reversal_id, tenant_id)
        REFERENCES public.import_reversals (id, tenant_id) ON DELETE CASCADE,

    CONSTRAINT import_reversal_failures_provenance_same_tenant
        FOREIGN KEY (provenance_id, tenant_id)
        REFERENCES public.import_row_provenance (id, tenant_id) ON DELETE CASCADE,

    -- One failure per row per attempt. A retry is a new reversal.
    CONSTRAINT import_reversal_failures_once UNIQUE (reversal_id, provenance_id),

    -- ⚠️ A BLANK REASON IS THE SAME DEFECT AS A MISSING ROW, wearing a value.
    -- The failed-rows CSV is the entire mechanism by which a customer finds
    -- these; `blocked_by` is its only content.
    CONSTRAINT import_reversal_failures_named
        CHECK (length(btrim(blocked_by)) >= 10),

    CONSTRAINT import_reversal_failures_target_pair
        CHECK ((target_table IS NULL) = (target_id IS NULL))
);

COMMENT ON TABLE public.import_reversal_failures IS
    'One row per row an undo could not undo, naming what blocked it. §4 refuses '
    'to let a reversal finish unless the number of these matches its own '
    'rows_unreversed — a count with nothing behind it is the true-summary-over-'
    'absent-detail shape this repository keeps finding. Phase 2, SQL 0208.';

COMMENT ON COLUMN public.import_reversal_failures.blocked_by IS
    'What stopped this row coming back, in a sentence the customer can act on. '
    'At least 10 characters, because "failed" and "error" are not answers and '
    'this string is the whole content of the report they are given.';

CREATE INDEX IF NOT EXISTS import_reversal_failures_reversal_idx
    ON public.import_reversal_failures (tenant_id, reversal_id);


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################

ALTER TABLE public.import_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_reversals FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_reversals_tenant_isolation ON public.import_reversals;
CREATE POLICY import_reversals_tenant_isolation
    ON public.import_reversals
    USING      ((tenant_id = app_current_tenant_id()) OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.import_reversal_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_reversal_failures FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_reversal_failures_tenant_isolation ON public.import_reversal_failures;
CREATE POLICY import_reversal_failures_tenant_isolation
    ON public.import_reversal_failures
    USING      ((tenant_id = app_current_tenant_id()) OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — 🔴🔴 NAME THE HUNDRED
-- ############################################################################
--
-- ⚠️ DEFERRED, FOR THE SAME REASON 0206 §4 IS. The reversal row is updated to
-- its final counts and the failure rows are inserted in whichever order the
-- caller finds convenient; the question is only meaningful at COMMIT.
--
-- ⚠️ AND IT FIRES ON UPDATE ONLY. A reversal is INSERTed as `running` with
-- zero counts and never finishes in the same statement it starts in.

CREATE OR REPLACE FUNCTION public.import_reversal_failures_named()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_named integer;
BEGIN
  IF NEW.status = 'running' THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::int INTO v_named
    FROM public.import_reversal_failures f
   WHERE f.reversal_id = NEW.id AND f.tenant_id = NEW.tenant_id;

  IF v_named <> NEW.rows_unreversed THEN
    RAISE EXCEPTION
      'Reversal % of run % reports % row(s) that could not be reversed and names '
      '%. Every one of them has to be named with what blocked it: a customer '
      'told that a hundred rows are still there, and given no way to find them, '
      'has been given a number rather than an answer — and will start their '
      'migration again on top of those rows.',
      NEW.id, NEW.run_id, NEW.rows_unreversed, v_named
      USING ERRCODE = '23502';
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.import_reversal_failures_named() IS
    'At COMMIT: a reversal that has stopped running must have exactly '
    'rows_unreversed rows in import_reversal_failures. The CHECK constraints in '
    '§1 stop the status contradicting the count; this stops the count standing '
    'in for the detail. 0208 §4.';

DROP TRIGGER IF EXISTS import_reversal_failures_named ON public.import_reversals;
CREATE CONSTRAINT TRIGGER import_reversal_failures_named
    AFTER UPDATE ON public.import_reversals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.import_reversal_failures_named();


-- ############################################################################
-- SECTION 5 — TENANT-TABLE OBLIGATIONS
-- ############################################################################

DO $$
DECLARE
  v_logged  text[];
  v_guarded text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_logged FROM attach_change_log_triggers() t;
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_guarded FROM attach_impersonation_guards() t;

  RAISE NOTICE
    '0208: change-log triggers attached to [%]; impersonation guards attached to [%].',
    array_to_string(v_logged, ', '), array_to_string(v_guarded, ', ');
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION — THE PREDICATE, NOT THE NAME
-- ══════════════════════════════════════════════════════════════════════════
--
-- 🔴 "THE CONSTRAINT EXISTS" IS NOT THE PROPERTY THIS FILE NEEDS.
-- `import_reversals_reversed_is_complete` weakened to `CHECK (true)` is still
-- a row in `pg_constraint` with the right name on the right table, and a
-- block that counts constraints reports success over it. What is asserted
-- below is `pg_get_constraintdef()` — the predicate PostgreSQL will actually
-- evaluate — normalised for whitespace and nothing else.
--
-- ⚠️ AND THE INDUCED PROOF IS NOT HERE, DELIBERATELY. Inducing these
-- refusals needs a tenant, a user and a run to hang them on, and writing
-- those rows inside a migration is DML on live tenant tables under FORCE row
-- level security — the exact shape `scripts/check-sql-rls-writes.mjs` exists
-- to refuse, and the 0092 incident it was written for. Worse, applied as the
-- superuser it would prove nothing anyway: a superuser bypasses every policy,
-- so the writes would succeed for a reason that has nothing to do with
-- whether the constraints work.
--
-- ⭐ THE INDUCTION LIVES IN `DRILL-DO-NOT-RUN-IN-NEON-0208a-partial-reversal.sql`,
-- which runs as `ordence_app` — NOSUPERUSER, NOBYPASSRLS — against the
-- bootstrap database. Its output is in TRACK-REPORT.md. Splitting them this
-- way makes the induced half STRONGER, not weaker: it runs as the role the
-- application actually connects as.

DO $$
DECLARE
  v_expected text[][] := ARRAY[
    ['import_reversals_reversed_is_complete',
     'CHECK ((((status)::text <> ''reversed''::text) OR ((rows_unreversed = 0) AND (rows_reversed = rows_considered))))'],
    ['import_reversals_partial_is_partial',
     'CHECK ((((status)::text <> ''partial''::text) OR (rows_unreversed > 0)))'],
    ['import_reversals_irreversible_refuses',
     'CHECK ((((kind)::text <> ''irreversible''::text) OR (((status)::text = ANY ((ARRAY[''running''::character varying, ''refused''::character varying])::text[])) AND (rows_reversed = 0))))'],
    ['import_reversals_explained',
     'CHECK ((((status)::text <> ALL ((ARRAY[''refused''::character varying, ''failed''::character varying])::text[])) OR (refusal_reason IS NOT NULL)))'],
    ['import_reversals_finished_has_time',
     'CHECK ((((status)::text = ''running''::text) = (finished_at IS NULL)))']
  ];
  v_name     text;
  v_want     text;
  v_have     text;
  i          integer;
BEGIN
  FOR i IN 1 .. array_length(v_expected, 1) LOOP
    v_name := v_expected[i][1];
    v_want := v_expected[i][2];

    SELECT pg_get_constraintdef(c.oid) INTO v_have
      FROM pg_constraint c
     WHERE c.conname = v_name
       AND c.conrelid = 'public.import_reversals'::regclass;

    IF v_have IS NULL THEN
      RAISE EXCEPTION
        '% is absent from import_reversals. Without it the product can record a '
        'status that contradicts the number beside it — which is how a customer '
        'is told their migration is gone while a hundred rows of it are still '
        'there.', v_name;
    END IF;

    IF regexp_replace(v_have, '\s+', ' ', 'g') <> regexp_replace(v_want, '\s+', ' ', 'g') THEN
      RAISE EXCEPTION
        '% exists on import_reversals with a DIFFERENT predicate. expected: % / found: %',
        v_name, v_want, v_have;
    END IF;
  END LOOP;

  -- The failure table's one content rule.
  SELECT pg_get_constraintdef(c.oid) INTO v_have
    FROM pg_constraint c
   WHERE c.conname = 'import_reversal_failures_named'
     AND c.conrelid = 'public.import_reversal_failures'::regclass;
  IF v_have IS DISTINCT FROM 'CHECK ((length(btrim(blocked_by)) >= 10))' THEN
    RAISE EXCEPTION
      'import_reversal_failures_named is absent or weakened (found: %). "failed" '
      'and "error" are not answers, and this string is the whole content of the '
      'report the customer is given.', coalesce(v_have, '(absent)');
  END IF;

  -- 🔴 AND THE ONE THAT IS NOT A CHECK CONSTRAINT AT ALL.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.import_reversals'::regclass
       AND tgname  = 'import_reversal_failures_named'
       AND tgdeferrable
  ) THEN
    RAISE EXCEPTION
      'import_reversal_failures_named is absent from import_reversals or is not '
      'DEFERRABLE. It is the control the CHECK constraints cannot be: a reversal '
      'that reports 100 unreversed rows and names three satisfies every '
      'constraint above perfectly. The count is honest and the report is useless. '
      'Deferred because the caller writes the failures and the final counts in '
      'whichever order it finds convenient, and the question is only meaningful '
      'at COMMIT.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'import_reversals'
       AND indexname = 'import_reversals_one_live_per_run'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%running%'
  ) THEN
    RAISE EXCEPTION
      'import_reversals_one_live_per_run is absent or is not a unique partial '
      'index on status = ''running''. Two concurrent undos of one run would each '
      'try to remove the same destination rows, and the loser would record a '
      'failure against a row that came back perfectly well.';
  END IF;

  RAISE NOTICE
    '0208: five CHECK predicates on import_reversals verified verbatim, the '
    'failures-are-named trigger is present and deferred, the one-live-undo index '
    'carries its predicate. Induction: DRILL-DO-NOT-RUN-IN-NEON-0208a.';
END $$;
