-- ############################################################################
-- 0275 · WHICH SYSTEM THE FILE CAME OUT OF, RECORDED ON THE RUN
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.84.1-alpha   ·   Phase 9, source adapters
-- Block: 0275–0284, allocated to PHASE-9. This file uses 0275 and nothing else.
--
-- ⚠️ NO `BEGIN`/`COMMIT`. The Neon browser console sends every statement on its
--    own connection, so a transaction wrapper would look atomic and not be.
--    Every statement below is independently idempotent.
--
-- ############################################################################
-- 🔴 THE QUESTION THIS COLUMN ANSWERS, AND WHY A NAME IS NOT ENOUGH
-- ############################################################################
--
-- `import_runs` already records `source_format` — csv, xlsx, json, tally-xml —
-- and `source_name`, which is what the customer called the file. Neither says
-- what Ordence BELIEVED that file was.
--
-- Phase 9 makes Ordence believe things. A file recognised as a Zoho Books
-- contacts export is read with Zoho's date prior; the same columns recognised
-- as nothing are read with no prior at all. Six months later, when 40,000 rows
-- have a date that is a month out, the question is not "what format was it" —
-- everybody can see it was a CSV. The question is "what did we think it was,
-- and did that decide the date order". Without this column there is no way to
-- ask it, because the file itself was never stored (0117, deliberately) and the
-- profile that read it was a runtime decision that left no trace.
--
-- ⭐ AND `generic` IS A VALUE, NOT A NULL. "Ordence looked at this file and
--    recognised no source system" and "nothing ever looked" are different
--    facts about a migration, and only the first one means the file was
--    genuinely unlike the six systems we know. NULL is reserved for the runs
--    that happened BEFORE this column existed, which is the one case where
--    nothing did look.
--
-- ############################################################################
-- ⚠️ THE CONSTRAINT IS THE SAME HAZARD GATE 20 EXISTS FOR, ONE COLUMN OVER
-- ############################################################################
--
-- `scripts/check-import-sources.mjs` opens by describing it: on the IMPORT
-- side the rows are already in the database by the time the run record is
-- written. A profile the reader can produce and this CHECK refuses would
-- produce a migration that reads the file, plans it, writes forty thousand
-- rows, and THEN fails at the run record — the customer's data imported, with
-- no record of what it was read as, and a screen saying the import failed.
--
-- 🔴 SO THE LIST BELOW AND `SOURCE_PROFILES` IN
--    `lib/import/profiles/registry.ts` MUST AGREE, and something has to check
--    that they do. `checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys })`
--    compares them; `tests/ui/import-profiles.test.ts` reads THIS FILE, pulls
--    the literals out of the constraint, and hands them over. A gate wiring
--    for CI is written out in `PATCH-REQUEST-PHASE-9.md` §6 — the script lives
--    in `scripts/`, which belongs to integration.
--
-- ############################################################################
-- NOTES FOR WHOEVER RUNS IT
-- ############################################################################
-- • Idempotent: the column is added `IF NOT EXISTS` and the constraint is
--   dropped and recreated, so a second run is a no-op rather than an error.
--   That matters here: this file is applied by hand, in a console, possibly
--   twice.
-- • NULLABLE, and it stays nullable. Making it NOT NULL would require a
--   back-fill of a value nobody measured for every run that already happened.
-- • No RLS statements. `import_runs` is already ENABLE + FORCE ROW LEVEL
--   SECURITY with `import_runs_tenant_isolation` from 0117, and a column does
--   not change a policy.
-- • The verification RAISES, and the second block PROVES THE CONSTRAINT
--   REFUSES rather than proving it exists. See the comment above it.
-- ############################################################################


-- ============================================================================
-- ① THE COLUMN
-- ============================================================================

ALTER TABLE public.import_runs
    ADD COLUMN IF NOT EXISTS source_profile varchar(20);


COMMENT ON COLUMN public.import_runs.source_profile IS
    'Which source system Ordence recognised this file as, from '
    'lib/import/profiles/registry.ts. "generic" means Ordence looked and '
    'recognised none of them, which is a different fact from NULL — NULL is a '
    'run that happened before 0275 added this column. The value decides which '
    'date order and which negative-amount convention were assumed when the '
    'values themselves did not settle it, so it is the first thing to read '
    'when a migrated date or sign turns out wrong.';


-- ============================================================================
-- ② THE CHECK · THE LIST THAT MUST MATCH THE REGISTRY
-- ============================================================================
--
-- ⚠️ DROP THEN ADD, rather than `ADD CONSTRAINT IF NOT EXISTS` — which
--    Postgres does not have for table constraints. Dropping first is also what
--    makes this file the right place to CHANGE the list when an eighth profile
--    is written: re-running it replaces the constraint rather than colliding
--    with it.

ALTER TABLE public.import_runs
    DROP CONSTRAINT IF EXISTS import_runs_source_profile_known;

ALTER TABLE public.import_runs
    ADD CONSTRAINT import_runs_source_profile_known
        CHECK (source_profile IS NULL OR source_profile IN (
            'tally',
            'busy',
            'marg',
            'zoho-books',
            'quickbooks',
            'xero',
            'generic'
        ));


-- ============================================================================
-- ③ SELF-VERIFICATION · THE COLUMN AND THE CONSTRAINT EXIST, EXACTLY
-- ============================================================================
--
-- ⚠️ IT ASSERTS THE EXACT SET, NOT A COUNT. `count(*) = 7` would pass on a
--    constraint listing seven wrong names, and would say nothing useful when
--    it failed. This one reports which names are missing and which are extra,
--    by name, in the exception message — because the person reading that
--    message is in a console at an awkward hour and has no debugger.

DO $$
DECLARE
    wanted   text[] := ARRAY[
        'tally', 'busy', 'marg', 'zoho-books', 'quickbooks', 'xero', 'generic'
    ];
    coldef   record;
    condef   text;
    -- ⚠️ NOT `found`. plpgsql has a special variable of that name, set by
    --    every SELECT INTO, and declaring one shadows it: the `IF NOT FOUND`
    --    below then reads a text[] and the block dies at run time with
    --    "argument of NOT must be type boolean, not type text[]". CREATE
    --    succeeds; the failure only appears when the file is applied. Found by
    --    executing this migration against PostgreSQL 16, not by reading it.
    listed   text[];
    missing  text[];
    extra    text[];
BEGIN
    SELECT a.attnotnull AS notnull, t.typname AS typname, a.atttypmod AS typmod
      INTO coldef
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
      JOIN pg_type      t ON t.oid = a.atttypid
     WHERE c.relname      = 'import_runs'
       AND c.relnamespace = 'public'::regnamespace
       AND a.attname      = 'source_profile'
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'import_runs.source_profile does not exist. The ALTER above did not take, so every '
            'migration run from here on records what the file WAS and not what Ordence read it AS.';
    END IF;

    IF coldef.notnull THEN
        RAISE EXCEPTION
            'import_runs.source_profile is NOT NULL. It must stay nullable: NULL is how a run '
            'that happened before 0275 says that nothing ever looked, which is a different fact '
            'from the "generic" profile, and a back-fill would invent a value nobody measured.';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO condef
      FROM pg_constraint
     WHERE conname       = 'import_runs_source_profile_known'
       AND conrelid      = 'public.import_runs'::regclass;

    IF condef IS NULL THEN
        RAISE EXCEPTION
            'import_runs_source_profile_known is missing. Without it the run record accepts any '
            'string, and a typo in a profile key becomes a source system nobody notices.';
    END IF;

    SELECT array_agg(m[1] ORDER BY m[1])
      INTO listed
      FROM regexp_matches(condef, '''([a-z0-9-]+)''', 'g') AS m;

    SELECT array_agg(w ORDER BY w) INTO missing
      FROM unnest(wanted) AS w
     WHERE NOT (w = ANY (coalesce(listed, ARRAY[]::text[])));

    SELECT array_agg(f ORDER BY f) INTO extra
      FROM unnest(coalesce(listed, ARRAY[]::text[])) AS f
     WHERE NOT (f = ANY (wanted));

    IF missing IS NOT NULL OR extra IS NOT NULL THEN
        RAISE EXCEPTION
            'import_runs_source_profile_known does not list the profiles this migration was '
            'written for. Missing: %. Unexpected: %. The registry in '
            'lib/import/profiles/registry.ts and this constraint have to be the same list, or a '
            'migration read under a profile this refuses writes every row and then fails at the '
            'run record.',
            coalesce(array_to_string(missing, ', '), '(none)'),
            coalesce(array_to_string(extra,   ', '), '(none)');
    END IF;

    RAISE NOTICE 'Phase 9: import_runs.source_profile is nullable varchar and lists all 7 profiles.';
END $$;


-- ============================================================================
-- ④ 🔴 AND A SECOND BLOCK THAT PROVES THE CONSTRAINT *REFUSES*
-- ============================================================================
--
-- ⭐ BLOCK ③ PROVES A CONSTRAINT EXISTS AND SPELLS SEVEN NAMES. It does not
--    prove that the predicate REJECTS anything, and those are different
--    claims: a constraint added `NOT VALID`, or one whose expression is
--    accidentally `true`, satisfies ③ completely.
--
--    This project's characteristic defect is declared-and-unenforced, and it
--    has been found four times in the checkers written to catch it. A gate
--    proven only by passing is not proven, so this one induces the failure.
--
-- ⚠️ THE PROBE TAKES THE REAL PREDICATE OUT OF THE CATALOG, and does not
--    restate it. `pg_get_constraintdef` returns the expression Postgres is
--    actually enforcing on `import_runs`; a hand-written copy here would be a
--    second model of the same rule, and the two would agree right up until the
--    day the constraint changed and this block went on passing.
--
-- ⚠️ AND IT RUNS ON A TEMP TABLE, NOT ON `import_runs`. Inserting a probe row
--    into the real table would need a tenant, a user and eight NOT NULL
--    columns, and would leave a fake migration in a customer's history. The
--    temp table exists for the length of this block and is dropped by name.

DO $$
DECLARE
    condef   text;
    refused  boolean := false;
    accepted boolean := false;
    nulls_ok boolean := false;
BEGIN
    SELECT pg_get_constraintdef(oid)
      INTO condef
      FROM pg_constraint
     WHERE conname  = 'import_runs_source_profile_known'
       AND conrelid = 'public.import_runs'::regclass;

    IF condef IS NULL THEN
        RAISE EXCEPTION 'import_runs_source_profile_known is missing; block 3 should have caught this.';
    END IF;

    DROP TABLE IF EXISTS pg_temp.source_profile_probe;
    CREATE TEMP TABLE source_profile_probe (source_profile varchar(20));
    EXECUTE format(
        'ALTER TABLE pg_temp.source_profile_probe ADD CONSTRAINT probe %s',
        condef
    );

    -- ⚠️ THE ONE THAT MUST BE REFUSED.
    BEGIN
        INSERT INTO pg_temp.source_profile_probe (source_profile) VALUES ('zoho');
    EXCEPTION WHEN check_violation THEN
        refused := true;
    END;

    -- And the two that must be accepted, because a predicate that refuses
    -- everything is just as broken and reads exactly the same from outside.
    BEGIN
        INSERT INTO pg_temp.source_profile_probe (source_profile) VALUES ('zoho-books');
        accepted := true;
    EXCEPTION WHEN check_violation THEN
        accepted := false;
    END;

    BEGIN
        INSERT INTO pg_temp.source_profile_probe (source_profile) VALUES (NULL);
        nulls_ok := true;
    EXCEPTION WHEN check_violation THEN
        nulls_ok := false;
    END;

    DROP TABLE pg_temp.source_profile_probe;

    IF NOT refused THEN
        RAISE EXCEPTION
            'import_runs_source_profile_known ACCEPTED the value ''zoho'', which is not a profile '
            'key — the real key is ''zoho-books''. The constraint exists and enforces nothing, so '
            'a typo in the writer would be stored and read back as a source system that does not '
            'exist.';
    END IF;

    IF NOT accepted THEN
        RAISE EXCEPTION
            'import_runs_source_profile_known REFUSED the value ''zoho-books'', which is a real '
            'profile key. Every Zoho migration would write its rows and then fail at the run '
            'record.';
    END IF;

    IF NOT nulls_ok THEN
        RAISE EXCEPTION
            'import_runs_source_profile_known REFUSED NULL. Every run recorded before 0275 has '
            'NULL here, so this constraint could never be validated against the existing table.';
    END IF;

    RAISE NOTICE
        'Phase 9: import_runs_source_profile_known refuses ''zoho'', accepts ''zoho-books'' and accepts NULL.';
END $$;
