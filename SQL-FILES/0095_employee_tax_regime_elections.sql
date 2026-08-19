-- ############################################################################
-- 0095 , WHERE THE TAX REGIME ELECTION LIVES, PER EMPLOYEE AND PER YEAR
-- ############################################################################
--
-- PURPOSE
-- -------
-- `employees.tax_regime` is a single enum column with no year attached to it.
-- It is the correct input for this month's withholding under s.192, and it is
-- the WRONG input for a Form 16 covering a financial year that has closed.
--
-- 🔴 THE CONSEQUENCE, WHICH IS NOT A COSMETIC ONE.
--    s.115BAC(6) makes the choice between the concessional and the old regime
--    an option exercisable FOR EACH PREVIOUS YEAR, and the Finance Act 2023
--    reversed which one is the DEFAULT. An employee who was on the old regime
--    in 2023-24 and moved to the new one in 2025-26 has two different, equally
--    valid elections on file. Reading the current flag to build the 2023-24
--    certificate restates a closed year under the wrong law and changes the
--    tax by a large amount , and nothing on the document says so.
--
--    That is the same class of defect `lib/registers/document.ts` exists to
--    prevent: same title, same employee, different figures, silently.
--
-- ⭐ WHY A jsonb COLUMN AND NOT A TABLE.
--    An election is at most one row per employee per year, it is only ever
--    read alongside the employee, it is never queried across tenants, and it
--    has no lifecycle of its own. A table would need a tenant_id, RLS ENABLED
--    and FORCED, a policy, an index and a join , five surfaces for a bug on a
--    payload of three scalars. The precedent is 0093 (`users.preferences`),
--    and the reader here is the same shape: `parseRegimeElections()` in
--    `lib/payroll/form16.ts` is TOTAL. Any object, any depth, any junk
--    resolves to a list of well-formed elections, possibly empty, and never
--    throws. The database stores bytes; the parser owns the meaning.
--
-- ⚠️ NO CHECK CONSTRAINT ON THE SHAPE, DELIBERATELY. A constraint would put
--    validation in two places, and the day they disagree is the day an HR user
--    cannot save a declaration. Any value the parser does not recognise
--    resolves to "no election recorded for that year", which makes
--    `buildForm16` REFUSE to issue the certificate. A refusal is a safe
--    failure; a defaulted regime is a wrong tax.
--
-- 🔴 NO BACKFILL, AND THIS IS THE MOST IMPORTANT LINE IN THE FILE.
--    '{}' is the TRUE value for every existing row: no employee has declared
--    anything through this field yet. Copying today's `tax_regime` into past
--    years would record an election the employee never made, on a document
--    they will file an income-tax return with. The correct behaviour for a
--    year with no election on file is to refuse to produce Form 16 Part B and
--    ask for the declaration, which is exactly what the engine does.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 and 0093, restated because the project has already lost
-- a day to it. Migrations here are PASTED INTO THE NEON BROWSER CONSOLE, which
-- sends each statement on its own connection turn. `BEGIN` buys no atomicity
-- across that boundary , it only makes a half-applied file look like a clean
-- one, which is how 0091 applied halfway and reported success. `SET LOCAL`
-- reports "executed successfully" and has evaporated before the next
-- statement runs.
--
-- ⭐ SO EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT and the file is safe
--    to re-run from the top after a failure at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS.
--    `ADD COLUMN` is DDL. It is not subject to a row-level security WITH
--    CHECK, so it needs no `app.platform_scope`, no `DO $$ ... $$` block and
--    no special role. A migration that never writes a row cannot be refused by
--    a policy , the failure mode 0091 and 0092 both hit. `employees` already
--    has RLS ENABLED and FORCED with a policy naming `app_current_tenant_id()`
--    and this file does not touch any of that.
--
-- RUN ORDER: after 0094. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If section 2 refuses, this row is still on your screen and still tells you
-- the two things worth knowing: whether the column is already there, and how
-- many employees are about to gain one.
-- ============================================================================

SELECT
    '0095 · diagnostic'                              AS finding,
    current_user                                     AS running_as,
    (SELECT count(*) FROM public.employees)          AS employee_rows,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'employees'
          AND column_name  = 'tax_regime_elections'
    )                                                AS column_already_present,
    (SELECT relrowsecurity  FROM pg_class WHERE oid = 'public.employees'::regclass)
                                                     AS rls_enabled,
    (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.employees'::regclass)
                                                     AS rls_forced;


-- ============================================================================
-- SECTION 2 · THE COLUMN · ONE IDEMPOTENT DDL STATEMENT
-- ============================================================================
--
-- ⚠️ `NOT NULL DEFAULT '{}'::jsonb` RATHER THAN NULLABLE. A nullable column
--    would give the reader two spellings of "nothing declared" (NULL and `{}`)
--    and a `coalesce` at every call site, one of which will be forgotten.
--    Since PostgreSQL 11 a NOT NULL column with a constant default is added
--    without rewriting the table, so this is a catalogue-only change.
-- ============================================================================

ALTER TABLE public.employees
    ADD COLUMN IF NOT EXISTS tax_regime_elections jsonb NOT NULL DEFAULT '{}'::jsonb;


-- ============================================================================
-- SECTION 3 · CONFIRMATION · THE ROW TO READ
-- ============================================================================

SELECT
    '0095 · verdict'                                 AS finding,
    c.column_name                                    AS column_name,
    c.data_type                                      AS data_type,
    c.is_nullable                                    AS is_nullable,
    c.column_default                                 AS column_default,
    CASE
        WHEN c.data_type = 'jsonb' AND c.is_nullable = 'NO'
            THEN 'PASS , employees.tax_regime_elections exists as NOT NULL jsonb; Form 16 Part B can now read the election the employee actually made for the year being certified, and refuses when there is none'
        ELSE 'FAIL , section 2 did not apply as written, send me the error from its tab'
    END                                              AS verdict
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name   = 'employees'
  AND c.column_name  = 'tax_regime_elections';
