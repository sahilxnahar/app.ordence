-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
--
--  ORDENCE — THE TWO-LIVE-TENANT ISOLATION FIXTURE
--  Version: v1.46.0-alpha
-- =====================================================================
--
--  It creates a schema, it creates DELIBERATELY BROKEN TABLES, and the
--  script that runs it goes on to create a LOGIN ROLE and hand it
--  ownership of everything in here. Throwaway Postgres only.
--
--     createdb tenantprobe
--     psql -q -d tenantprobe -f scripts/harness/tenant-isolation-fixture.sql
--
--  Normally it is not run by hand at all —
--  `scripts/check-tenant-isolation.mjs` executes it as step one and then
--  builds the real tenant tables on top of it, derived from the schema
--  and the migrations rather than written out here.
--
--  ⚠️ THE GUARD BELOW IS THE SAME ONE AS
--  `SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0081.sql`, AND IT IS NOT
--  DECORATION. The .mjs harness performs its own refusal on the
--  connection string before it ever opens a client; this one exists
--  because a human with a psql prompt open does not go through the .mjs.
--  Two independent refusals, because the cost of the first one being
--  bypassed is a CREATE ROLE and a DROP SCHEMA CASCADE on a database
--  holding customers' money.

-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() LIKE '%prod%'
     OR current_database() IN ('neondb', 'ordence', 'production', 'postgres')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. This fixture runs on a throwaway only.',
      current_database();
  END IF;
END
$$;


-- =====================================================================
--  STEP 1 — A SCHEMA THAT IS DESTROYED AND REBUILT EVERY RUN
-- =====================================================================
--
--  ⚠️ CASCADE, and deliberately so. The harness leaves nothing behind
--  between runs: a table surviving from a previous run would be seeded
--  with the previous run's rows, and a positive control that passes
--  because of yesterday's data is the exact failure this whole harness
--  exists to refuse.

DROP SCHEMA IF EXISTS tenantprobe CASCADE;
CREATE SCHEMA tenantprobe;

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =====================================================================
--  STEP 2 — ⭐⭐ THE MUTATION CONTROL: TABLES THAT MUST LEAK
-- =====================================================================
--
--  🔴 A HARNESS THAT HAS ONLY EVER BEEN SEEN TO PASS IS A HARNESS
--  NOBODY SHOULD TRUST.
--
--  Every assertion in `check-tenant-isolation.mjs` is of the form
--  "tenant B saw zero of tenant A's rows". That sentence is also what a
--  typo in a table name produces, and an empty table, and a session
--  that never connected. The positive controls rule out the last two —
--  but nothing in the harness proves the ASSERTION ITSELF can still
--  fire.
--
--  ⭐ SO THESE TWO TABLES ARE BUILT BROKEN, ON PURPOSE, ON EVERY RUN,
--  AND THE HARNESS RUNS ITS ORDINARY PROBE AGAINST THEM AND REQUIRES
--  BOTH TO BE REPORTED AS LEAKING. If either one comes back clean, the
--  probe has stopped detecting anything and the run FAILS — with a
--  message about the harness, not about the schema.
--
--  ⚠️ THEY ARE NAMED WITH A LEADING `__` AND LIVE ONLY IN THIS THROWAWAY
--  SCHEMA. They are not tables in the product, they are never created by
--  a migration, and the schema is dropped at the end of the run.

-- ---- ① NO ROW LEVEL SECURITY AT ALL ---------------------------------
--
--  The `deployment_releases` / `deployment_backups` / `security_batches`
--  / `flow_submissions` shape, recorded in `scripts/check-rls-coverage.mjs`:
--  a real `tenant_id` column, correct application queries, and no policy
--  anywhere. Every tenant reads every other tenant's rows and nothing
--  anywhere says so.
CREATE TABLE tenantprobe.__broken_no_rls_at_all (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL
);

-- ---- ② ENABLED BUT NOT FORCED ---------------------------------------
--
--  🔴 THE ONE THAT LOOKS RIGHT IN EVERY REVIEW. The policy is present
--  and correct; `ENABLE ROW LEVEL SECURITY` is present. `FORCE` is not.
--  Postgres exempts the TABLE OWNER from a policy unless the table is
--  also FORCEd — and the harness connects as the owner, because that is
--  what the application does on Neon.
--
--  So this table has a perfect-looking policy that is never once
--  evaluated. Reading the migration tells you nothing; only executing
--  does, which is the entire argument for this file existing.
CREATE TABLE tenantprobe.__broken_enabled_not_forced (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL
);
ALTER TABLE tenantprobe.__broken_enabled_not_forced ENABLE ROW LEVEL SECURITY;
-- ⚠️ DELIBERATELY NO `FORCE ROW LEVEL SECURITY` ON THE LINE BELOW.

--  ⚠️ THE PREDICATE IS WRITTEN OUT RAW rather than calling
--  `app_current_tenant_id()`. The harness replays that function's real
--  definition out of `SQL-FILES/` before it builds the product tables —
--  but if that extraction ever broke, the controls would fail to build,
--  the harness would find no broken tables to catch, and it would report
--  "the probe still detects leakage" on the basis of having probed
--  nothing. The control must not share a failure mode with the thing it
--  is controlling. This expression is byte-for-byte what
--  `app_current_tenant_id()` evaluates (SQL-FILES/0001, §1).
CREATE POLICY broken_enabled_not_forced_tenant_isolation
  ON tenantprobe.__broken_enabled_not_forced
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- =====================================================================
--  STEP 3 — WHAT DELIBERATELY IS **NOT** IN THIS FILE
-- =====================================================================
--
--  ⚠️ NOT ONE PRODUCT TABLE, AND NOT ONE PRODUCT POLICY.
--
--  There are 248 tenant-scoped tables. Writing their DDL here would
--  create a second copy of the schema that must be kept in step with
--  `db/schema/*.ts` and `SQL-FILES/*.sql` — and the copy that drifted
--  would be the one being tested, so the harness would go on passing
--  while testing a schema the product no longer has.
--
--  ⭐ SO THE HARNESS DERIVES THEM. Table names come from the Drizzle
--  schema (a `tenant_id` column is what makes a table tenant-scoped);
--  ENABLE / FORCE / the policy predicates are lifted VERBATIM out of the
--  migrations. A policy this repository has never written is a policy
--  the harness cannot accidentally invent a passing version of.
