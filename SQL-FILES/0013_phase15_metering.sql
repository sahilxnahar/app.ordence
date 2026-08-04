-- ============================================================================
-- Ordence — Phase 15: Usage Metering
-- Version: v0.14.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the two metering tables:
--   usage_counters, usage_levels
--
-- Contents:
--   1. Row-Level Security (both tables; both with USING *and* WITH CHECK)
--   2. usage_counters is MONOTONIC and its identity is FIXED
--   3. usage_levels — identity fixed, floor enforced
--   4. The atomicity guarantee: the ON CONFLICT arbiters must exist
--   5. Retention, under a different credential
--   6. Grants  (REVOKE first — this is not padding)
--   7. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Metering is the substrate Phase 16 bills from. Its failures are quiet in a
-- way that billing's are not: an invoice that is wrong gets disputed within a
-- month, whereas a counter that stopped incrementing produces NO SYMPTOM AT
-- ALL — no error, no empty screen, no failed request. The number is simply
-- smaller than the truth, and the only party who might notice is the one who
-- benefits from it.
--
-- Four guarantees are therefore enforced by the DATABASE, because the
-- application layer that writes them is best-effort BY DESIGN and will
-- silently swallow anything it gets wrong:
--
--   • Concurrent increments cannot lose an update.        (Section 4)
--   • A cumulative counter cannot be made to go DOWN.     (Section 2)
--   • A stored level cannot go NEGATIVE.                  (Section 3)
--   • A tenant cannot read or write another's usage.      (Section 1)
--
-- ============================================================================


-- The tenant-context accessor. Idempotent; also created by earlier phases.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER, which is usually the
-- role the application connects as. Without FORCE the isolation is decorative.
--
-- ---------------------------------------------------------------------------
-- NOTE THE ABSENCE OF A NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- `payment_events` (Phase 11), `error_events` (Phase 19) and `security_events`
-- (Phase 20) all carry a NULLABLE tenant_id, because each of them records
-- things that happen before a tenant is known — an unmappable webhook, a Web
-- Vital fired pre-session, a forged HMAC.
--
-- Usage is not like that. There is no such thing as an email sent by nobody or
-- a byte stored by no one; if we cannot attribute a unit of usage to a tenant,
-- we cannot bill it and we must not invent a row for it. So `tenant_id` is
-- NOT NULL on both tables and both policies are a plain equality — which is
-- also the strictest form, and the one that needs no commentary to be read
-- correctly six months from now.
-- ---------------------------------------------------------------------------

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_counters_tenant_isolation ON usage_counters;
CREATE POLICY usage_counters_tenant_isolation ON usage_counters
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE usage_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_levels FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_levels_tenant_isolation ON usage_levels;
CREATE POLICY usage_levels_tenant_isolation ON usage_levels
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — usage_counters IS MONOTONIC, AND ITS IDENTITY IS FIXED
-- ############################################################################
--
-- WHY THIS TABLE IS NOT APPEND-ONLY LIKE THE OTHER EVIDENCE TABLES
--
--   `audit_logs`, `payment_events`, `contract_signatures` and
--   `security_events` all refuse UPDATE outright. This one cannot: the whole
--   concurrency design is
--
--       INSERT ... ON CONFLICT DO UPDATE SET value = value + excluded.value
--
--   which IS an UPDATE. Refusing it would force one row per metered
--   occurrence — an event table — and a row per API call is a cost we
--   deliberately declined to pay (see db/schema/metering.ts).
--
--   So the guarantee is narrowed to the one that still has teeth:
--
--       ⭐ A COUNTER MAY GO UP. IT MAY NEVER GO DOWN, AND IT MAY NEVER BE
--         MOVED TO ANOTHER TENANT, METRIC OR PERIOD.
--
-- THE HOLE THIS CLOSES:
--   The only reasons to lower a cumulative counter are to under-bill, to hide
--   usage from a customer who is about to be charged for it, or to paper over
--   a bug. The realistic version is the third: an engineer "fixing" a
--   double-counted month with an UPDATE rather than investigating why it
--   double-counted. The evidence of the bug disappears along with the symptom.
--
--   Moving a bucket's period is the same class of problem wearing a different
--   hat — it silently relocates usage onto a different invoice.
--
--   SQLSTATE 42501 is raised deliberately, so the application (and the test
--   suite) can distinguish this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_usage_counter_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.value < OLD.value THEN
    RAISE EXCEPTION
      'usage_counters.value cannot decrease (% -> % for metric % on tenant %). '
      'A cumulative counter only goes up. Record a correcting adjustment in the '
      'current period instead of editing a closed one.',
      OLD.value, NEW.value, OLD.metric, OLD.tenant_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id
     OR NEW.metric       IS DISTINCT FROM OLD.metric
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end   IS DISTINCT FROM OLD.period_end
  THEN
    RAISE EXCEPTION
      'A usage bucket cannot be re-identified. tenant_id, metric and the period '
      'are fixed at creation — moving them relocates usage onto a different '
      'invoice.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_counters_monotonic ON usage_counters;
CREATE TRIGGER usage_counters_monotonic
  BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION prevent_usage_counter_regression();


-- ############################################################################
-- SECTION 3 — usage_levels: IDENTITY FIXED, FLOOR ENFORCED
-- ############################################################################
--
-- A level DOES go down — that is the entire point of it being a level, and it
-- is what stops a customer who has spent an afternoon deleting old files from
-- still being told they are full. So there is no monotonicity guard here, and
-- adding one "for consistency" would break the phase's central requirement.
--
-- What IS guarded:
--
--   • The row's identity. A level row moved between tenants would transfer a
--     storage reading — and with it a quota — to somebody else.
--
--   • The floor. `usage_levels_current_non_negative` (a CHECK created by
--     Drizzle) refuses a negative reading. The application clamps with
--     GREATEST(0, ...) on every decrement, so the constraint should never
--     fire; it exists for the NEXT call site, written by someone who did not
--     read this file. A tenant whose storage reads -2 GB has an allowance
--     2 GB larger than the one they paid for, and nothing anywhere reports it.

CREATE OR REPLACE FUNCTION prevent_usage_level_reidentification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.metric IS DISTINCT FROM OLD.metric
  THEN
    RAISE EXCEPTION
      'A usage level cannot be reassigned to a different tenant or metric.'
      USING ERRCODE = '42501';
  END IF;

  -- The peak is a high-water mark for the period. Lowering it below the
  -- current reading would understate what was actually stored, which is the
  -- figure Phase 16 may bill on.
  IF NEW.peak_value < NEW.current_value THEN
    RAISE EXCEPTION
      'usage_levels.peak_value (%) cannot be below current_value (%).',
      NEW.peak_value, NEW.current_value
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_levels_identity_fixed ON usage_levels;
CREATE TRIGGER usage_levels_identity_fixed
  BEFORE UPDATE ON usage_levels
  FOR EACH ROW EXECUTE FUNCTION prevent_usage_level_reidentification();


-- ############################################################################
-- SECTION 4 — THE ATOMICITY GUARANTEE
-- ############################################################################
--
-- ⭐ THIS SECTION IS THE MOST IMPORTANT ONE IN THE FILE.
--
-- Every increment in this phase is a single statement:
--
--   INSERT INTO usage_counters (...) VALUES (...)
--   ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
--     SET value = usage_counters.value + excluded.value;
--
-- That statement is atomic ONLY BECAUSE the unique index named below exists.
-- It is the arbiter the ON CONFLICT clause names. Without it:
--
--   • PostgreSQL raises 42P10 ("no unique or exclusion constraint matching the
--     ON CONFLICT specification") — inside a recorder that SWALLOWS ITS OWN
--     ERRORS by design. Every increment fails, nothing is logged to the user,
--     no request breaks, and usage silently reads zero forever.
--
-- The index is created by Drizzle. It is asserted here because `drizzle-kit
-- push` treats anything it does not recognise as drift and drops it, and this
-- particular loss has no symptom whatsoever until an invoice run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_counters'
      AND indexname = 'usage_counters_tenant_metric_period_unique'
  ) THEN
    RAISE EXCEPTION
      'usage_counters_tenant_metric_period_unique is MISSING. Without it the '
      'ON CONFLICT upsert has no arbiter, every increment raises 42P10 inside a '
      'best-effort recorder, and ALL USAGE SILENTLY READS ZERO. '
      'Re-run `npm run db:push` before continuing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_levels'
      AND indexname = 'usage_levels_tenant_metric_unique'
  ) THEN
    RAISE EXCEPTION
      'usage_levels_tenant_metric_unique is MISSING. Without it every storage '
      'adjustment INSERTs a second row for the same tenant, and the reported '
      'level stops tracking reality. Re-run `npm run db:push`.';
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — RETENTION, UNDER A DIFFERENT CREDENTIAL
-- ############################################################################
--
-- Old buckets are evidence for a bill that has already been paid, so they are
-- kept for years, not months — an overage dispute can arrive long after the
-- invoice. But they are not kept forever, and the pruning is deliberately NOT
-- available to the application role.
--
-- Same reasoning as `prune_security_events()` in Phase 20: deleting billing
-- history should require a different credential from the one the web
-- application holds. The application has no DELETE on either table (Section 6),
-- so this function is the only path, and it is granted to nobody by default.
--
-- 25 months is the default: two full years plus a month, so a
-- year-on-year comparison and a GST assessment window both still work.

CREATE OR REPLACE FUNCTION prune_usage_counters(older_than interval DEFAULT '25 months')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM usage_counters
   WHERE period_end < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;

  RAISE NOTICE 'prune_usage_counters: removed % closed buckets older than %',
    removed, older_than;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION prune_usage_counters(interval) FROM PUBLIC;


-- ############################################################################
-- SECTION 6 — GRANTS
-- ############################################################################
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — which is the first thing most people do when a query fails with
-- "permission denied", and which several hosting providers' guides recommend
-- outright — then the application role already holds DELETE on both tables and
-- every GRANT below is a no-op.
--
-- WHY NO DELETE, ON EITHER TABLE:
--
--   usage_counters — a deleted bucket is usage that was consumed and will
--     never be billed. It is also the only record of what a customer used in
--     a month they may later dispute. Deletion is retention (Section 5), under
--     a different credential.
--
--   usage_levels — deleting a level row resets a tenant's stored bytes to
--     zero. That is not a cleanup, it is a free storage upgrade, available to
--     any code path that can issue a DELETE. Tenant teardown is handled by
--     ON DELETE CASCADE from `tenants`, which needs no privilege here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON usage_counters FROM ordence_app;
    REVOKE ALL ON usage_levels   FROM ordence_app;

    -- SELECT, INSERT and UPDATE only. UPDATE is required — it is the second
    -- half of every ON CONFLICT DO UPDATE — and is constrained by the
    -- monotonic trigger in Section 2 rather than by withholding the privilege.
    GRANT SELECT, INSERT, UPDATE ON usage_counters TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON usage_levels   TO ordence_app;

    -- Explicitly NOT granted: EXECUTE on prune_usage_counters().
  END IF;
END
$$;


-- ############################################################################
-- SECTION 7 — VERIFICATION
-- ############################################################################
--
-- Every check below prints a row. Read them. A silent success is not the same
-- as a success — and in this phase, more than any other, a silent FAILURE
-- produces no symptom at all.

-- Check 1 — RLS is enabled AND forced on both tables.
SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS' ELSE '*** FAIL ***' END         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('usage_counters','usage_levels')
ORDER BY c.relname;


-- Check 2 — every policy carries a WITH CHECK clause.
--
-- A policy with only USING filters what you can READ but permits INSERTing a
-- row belonging to another tenant. Here that would mean tenant B could write
-- usage onto tenant A's bucket — inflating a stranger's invoice and consuming
-- their quota. Reads would look perfectly correct throughout.
SELECT
  tablename,
  policyname,
  CASE WHEN with_check IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — reads filtered, writes are not ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('usage_counters','usage_levels')
ORDER BY tablename;


-- Check 3 — ⭐ the ON CONFLICT arbiters exist.
--
-- THE MOST IMPORTANT ROW IN THIS FILE. Without these indexes every increment
-- fails with 42P10 inside a recorder that swallows errors by design, and all
-- usage silently reads zero.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_counters'
      AND indexname = 'usage_counters_tenant_metric_period_unique'
  ) THEN 'PASS: the counter upsert has an arbiter — increments are atomic'
  ELSE  '*** FAIL: usage_counters_tenant_metric_period_unique IS MISSING — '
        'ALL USAGE WILL SILENTLY READ ZERO ***'
  END AS verdict
UNION ALL
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_levels'
      AND indexname = 'usage_levels_tenant_metric_unique'
  ) THEN 'PASS: the level upsert has an arbiter'
  ELSE  '*** FAIL: usage_levels_tenant_metric_unique IS MISSING — '
        'storage will fork into duplicate rows ***'
  END;


-- Check 4 — the integrity triggers exist and are enabled.
SELECT
  tgrelid::regclass::text AS table_name,
  tgname                  AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       -- `tgenabled` is PostgreSQL's internal "char" type, not text. Without
       -- the cast this line fails with `operator is not unique: unknown || "char"`.
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid IN ('usage_counters'::regclass, 'usage_levels'::regclass)
  AND NOT tgisinternal
ORDER BY table_name, trigger_name;


-- Check 5 — ⭐ the two metric-kind CHECK constraints exist.
--
-- These are what stop `storage_bytes` being written into the tally table (so
-- that stored bytes would rise forever and never fall when a customer deletes
-- something) and stop `emails_sent` being written into the level table (where
-- it could be decremented, erasing usage before it is invoiced).
--
-- `tests/security/metering-isolation.test.ts` goes further and asserts the
-- constraint text still matches the TypeScript metric definitions.
SELECT
  conrelid::regclass::text AS table_name,
  conname                  AS constraint_name,
  pg_get_constraintdef(oid) AS definition,
  'PASS'                   AS verdict
FROM pg_constraint
WHERE conname IN ('usage_counters_metric_is_cumulative', 'usage_levels_metric_is_level')
ORDER BY conname;
-- (Two rows expected. FEWER THAN TWO IS A FAILURE — the metric kinds are no
--  longer enforced and a single wrong call site silently corrupts a quota.)


-- Check 6 — no counter has ever gone negative.
SELECT
  tenant_id, metric, period_start, value,
  '*** FAIL — a cumulative counter is negative ***' AS verdict
FROM usage_counters
WHERE value < 0;
-- (No rows returned = PASS.)


-- Check 7 — no stored level is negative, and no peak understates its level.
--
-- A negative storage reading gives a tenant an allowance LARGER than the one
-- they paid for. A peak below the current value understates the figure Phase
-- 16 may bill on.
SELECT
  tenant_id, metric, current_value, peak_value,
  CASE WHEN current_value < 0
       THEN '*** FAIL — negative storage level: this tenant has a larger allowance than they bought ***'
       ELSE '*** FAIL — peak is below the current reading ***' END AS verdict
FROM usage_levels
WHERE current_value < 0 OR peak_value < current_value;
-- (No rows returned = PASS.)


-- Check 8 — no bucket has an inverted or zero-length period.
SELECT
  tenant_id, metric, period_start, period_end,
  '*** FAIL — period ends before it starts; every figure derived from it is wrong ***' AS verdict
FROM usage_counters
WHERE period_end <= period_start;
-- (No rows returned = PASS.)


-- Check 9 — a tenant cannot have two buckets for the same metric and period.
--
-- Belt and braces alongside the unique index: if the index was created AFTER
-- data existed, duplicates could predate it — and duplicates mean the usage
-- page and the invoice would read different halves of the same month.
SELECT
  tenant_id, metric, period_start, count(*) AS buckets,
  '*** FAIL — duplicate buckets; usage is split across rows ***' AS verdict
FROM usage_counters
GROUP BY tenant_id, metric, period_start
HAVING count(*) > 1;
-- (No rows returned = PASS.)


-- Check 10 — the application role can accumulate but cannot erase.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', 'usage_counters', 'INSERT')
     AND has_table_privilege('ordence_app', 'usage_counters', 'UPDATE')
     AND NOT has_table_privilege('ordence_app', 'usage_counters', 'DELETE')
     AND NOT has_table_privilege('ordence_app', 'usage_levels',  'DELETE')
      THEN 'PASS: the app can increment usage but cannot delete a bucket or reset a level'
    ELSE '*** FAIL: the application role can DELETE usage records — '
         'a deleted bucket is usage that will never be billed, and a deleted '
         'level row is a free storage upgrade ***'
  END AS verdict;


-- Check 11 — the metric vocabulary, for eyeballing against
-- `lib/metering/quota.ts`. The security suite asserts equality; this is here
-- so a human running the file can see what the database believes.
SELECT
  string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS usage_metric_values
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'usage_metric';


-- Check 12 — retention is NOT reachable from the application role.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_function_privilege('ordence_app', 'prune_usage_counters(interval)', 'EXECUTE')
      THEN '*** FAIL: the application role can prune billing history ***'
    ELSE 'PASS: pruning usage history requires a different credential'
  END AS verdict;
