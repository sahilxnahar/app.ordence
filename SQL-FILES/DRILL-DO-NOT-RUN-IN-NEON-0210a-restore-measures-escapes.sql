-- ############################################################################
-- DRILL 0210a — A RESTORE THAT MEASURES WHAT IT COULD NOT PUT BACK
--               (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- 🔴🔴 DO NOT RUN THIS AGAINST NEON. It creates a tenant and a company row.
--      Everything is in one transaction that the last line ROLLS BACK, and
--      that is still not a reason to point it at a customer's books.
--
--     psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0210a-restore-measures-escapes.sql
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT THIS SHOWS, AND WHY IT IS NOT AN IMPLEMENTATION DETAIL
-- ══════════════════════════════════════════════════════════════════════════
-- `companies` declares, in `lib/import/entities.ts`:
--
--     reversal: { kind: "restore-prior", capturePriorFields: ["*"],
--                 escapes: null,  ← "nothing survives an undo of this"
--                 because: "…" }
--
-- `companies` also carries `companies_set_updated_at`, a BEFORE UPDATE
-- trigger whose entire body is `NEW.updated_at = now()`. So `updated_at`
-- cannot come back — not for this code, not for any caller, not by any means
-- available to the application. The declaration is wrong.
--
-- ⚠️ CI GATE 29 CANNOT SEE IT AND NEVER WILL. `checkImportContract()` is
-- pure by design — that is what lets the wizard run it in a browser — and a
-- pure checker cannot ask `pg_trigger` anything. `escapes: null` is a claim
-- an author wrote and nothing has ever checked.
--
-- ⭐ `import_restore_prior_values()` RE-READS THE ROW AFTER WRITING IT and
-- returns every column that did not come back. That turns "what escapes an
-- undo" from an assurance into a measurement made by the statement that did
-- the work — and `server/import/reversal.ts` puts the result in front of the
-- customer instead of the declaration.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ THE FIXTURE IS DATED IN THE PAST, AND THAT IS LOAD-BEARING
-- ══════════════════════════════════════════════════════════════════════════
-- Inside one transaction `now()` is the TRANSACTION timestamp and does not
-- move. A row inserted, overwritten and restored in a single transaction
-- therefore has the same `updated_at` throughout — and a drill written that
-- way reports that nothing escapes, which is false. The first draft of
-- SQL 0210's own self-test did exactly that and passed while measuring
-- nothing. `set_updated_at` is a BEFORE **UPDATE** trigger, so an INSERT may
-- carry an explicit past timestamp; that is also the real case, a record the
-- customer had before the migration.
-- ############################################################################

BEGIN;

SELECT set_config('app.current_tenant_id', '00000000-0000-4000-8000-0000000d2100', true);

INSERT INTO tenants (id, clerk_org_id, name, slug)
VALUES ('00000000-0000-4000-8000-0000000d2100', 'org_drill_0210', 'Drill 0210', 'drill-0210');

INSERT INTO companies (id, tenant_id, name, website, notes, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000d2101',
        '00000000-0000-4000-8000-0000000d2100',
        'Kaveri Traders',
        'https://kaveri.invalid',
        'MD prefers a call before 10am. Do not email.',
        now() - interval '400 days',
        now() - interval '120 days');

\echo ''
\echo '=== the row as the customer had it, before any migration ==='
SELECT name, website, notes, updated_at FROM companies
 WHERE id = '00000000-0000-4000-8000-0000000d2101';

-- ⭐ ① CAPTURE, BEFORE THE OVERWRITE. `observed_xmin` is the evidence of when.
CREATE TEMP TABLE drill_capture AS
SELECT * FROM import_capture_prior_values(
  'companies',
  '00000000-0000-4000-8000-0000000d2101',
  '00000000-0000-4000-8000-0000000d2100',
  ARRAY['*']
);

-- ② THE IMPORT, IN `update` MODE. It writes two columns and blanks a third
--    that it never had any business writing — which is what a real import in
--    update mode does to a record it did not create.
UPDATE companies
   SET name = 'KAVERI TRADERS PVT LTD', website = NULL, notes = NULL
 WHERE id = '00000000-0000-4000-8000-0000000d2101';

\echo ''
\echo '=== the row after the import ==='
SELECT name, website, notes FROM companies
 WHERE id = '00000000-0000-4000-8000-0000000d2101';

-- ③ THE UNDO.
\echo ''
\echo '=== the restore, and WHAT IT MEASURED ==='
\echo '    EXPECT: rows_affected = 1, unrestored = {updated_at}'
SELECT r.rows_affected, r.unrestored
  FROM drill_capture c,
       LATERAL import_restore_prior_values(
         'companies',
         '00000000-0000-4000-8000-0000000d2101',
         '00000000-0000-4000-8000-0000000d2100',
         c.prior_values,
         ARRAY['*']
       ) r;

\echo ''
\echo '=== the row after the undo — including the note the import never wrote ==='
SELECT name, website, notes FROM companies
 WHERE id = '00000000-0000-4000-8000-0000000d2101';

-- ④ AND THE ASSERTION, so this drill cannot be read as merely interesting.
DO $$
DECLARE
  v_name  text;
  v_notes text;
  v_web   text;
BEGIN
  SELECT name, notes, website INTO v_name, v_notes, v_web
    FROM companies WHERE id = '00000000-0000-4000-8000-0000000d2101';

  IF v_name <> 'Kaveri Traders' THEN
    RAISE EXCEPTION 'The name did not come back: %', v_name;
  END IF;
  IF v_web IS DISTINCT FROM 'https://kaveri.invalid' THEN
    RAISE EXCEPTION
      'A column the import set to NULL did not come back. Restoring only the '
      'non-null columns is how an undo leaves the migration''s blanks behind.';
  END IF;
  IF v_notes IS DISTINCT FROM 'MD prefers a call before 10am. Do not email.' THEN
    RAISE EXCEPTION
      'The note did not come back. `capturePriorFields: ["*"]` is what makes a '
      'field the import never wrote survive an undo; an entity that listed only '
      'the columns it writes would restore the name and lose this.';
  END IF;

  RAISE NOTICE
    'DRILL 0210a: the row came back, including a column the import blanked and '
    'a column it never wrote. The one thing that did not come back was named.';
END $$;

\echo ''
\echo '=== and the role this ran as, so the output cannot be misread ==='
SELECT current_user,
       (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls;

ROLLBACK;
