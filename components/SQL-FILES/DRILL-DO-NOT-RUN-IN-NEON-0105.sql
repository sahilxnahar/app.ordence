-- =====================================================================
--  DRILL , DO NOT RUN THIS IN NEON
-- =====================================================================
--
--  It creates `ai_provider_credentials` exactly as 0105 ships it, seeds
--  two workspaces, and then deliberately tries to break tenant isolation
--  so the refusals can be read rather than assumed.
--
--     createdb drill0105
--     createuser drill_app --no-superuser --no-createdb --no-createrole
--     psql -q -d drill0105 -f DRILL-DO-NOT-RUN-IN-NEON-0105.sql
--
--  THIS DRILL REFUSES TO RUN AS A SUPERUSER, AND UNLIKE 0085'S IT HAS TO.
--
--  What is under test here IS a permission. A superuser and a role with
--  rolbypassrls both walk straight past a row-level security policy, so
--  every "MUST BE REFUSED" below would pass silently and prove exactly
--  nothing. That is not hypothetical: it is the failure mode named in
--  scripts/check-sql-rls-writes.mjs, where 0092 was reviewed, applied
--  cleanly from a terminal, and still failed in the browser console
--  because it had never been executed as the role that would run it.
--
--  EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A drill
--  that only shows breaks cannot tell "the policy works" from "the table
--  rejects everything", and a table that rejects everything passes every
--  refusal in this file.
--
--  THE HEADLINE IS STEP 4: workspace B, holding workspace A's tenant id,
--  cannot write a row into A, cannot read A's rows, and cannot delete
--  them. That is the only tenant boundary this product has.
-- =====================================================================


-- =====================================================================
--  STEP 0 , REFUSE TO RUN SOMEWHERE THAT MATTERS, OR AS SOMEBODY WHO
--           CANNOT BE REFUSED
-- =====================================================================
DO $guard$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      'REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = current_user
                AND (rolsuper OR rolbypassrls))
  THEN
    RAISE EXCEPTION
      'REFUSING: "%" is a superuser or carries BYPASSRLS, so every refusal in this drill would pass without proving anything. Re-run as an ordinary role.',
      current_user;
  END IF;
END
$guard$;


-- =====================================================================
--  STEP 1 , THE SHAPES
-- =====================================================================
--  `tenants` and `users` are cut down to what 0105 references.
--  ai_provider_credentials is copied from 0105 as it ships.

DROP TABLE IF EXISTS ai_provider_credentials, users, tenants CASCADE;
DROP FUNCTION IF EXISTS app_current_tenant_id() CASCADE;

CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid;
$fn$;

CREATE TABLE tenants (id uuid PRIMARY KEY, slug text);
CREATE TABLE users   (id uuid PRIMARY KEY, email text);

INSERT INTO tenants (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'workspace-a'),
  ('22222222-2222-2222-2222-222222222222', 'workspace-b');

CREATE TABLE ai_provider_credentials (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider_id           varchar(60) NOT NULL,
    account_id            varchar(120),
    status                varchar(20) NOT NULL DEFAULT 'active',
    last_success_at       timestamptz,
    last_used_at          timestamptz,
    use_count             bigint      NOT NULL DEFAULT 0,
    last_failure_at       timestamptz,
    last_failure_kind     varchar(30),
    last_failure_message  text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT ai_provider_credentials_status_valid
        CHECK (status IN ('active', 'disabled', 'failing')),
    CONSTRAINT ai_provider_credentials_use_count_non_negative
        CHECK (use_count >= 0),
    CONSTRAINT ai_provider_credentials_cloudflare_needs_account
        CHECK (provider_id <> 'cloudflare_workers_ai'
               OR (account_id IS NOT NULL AND length(btrim(account_id)) > 0))
);

CREATE UNIQUE INDEX ai_provider_credentials_provider_key
    ON ai_provider_credentials (tenant_id, provider_id);

ALTER TABLE ai_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_credentials FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_credentials_tenant_isolation
    ON ai_provider_credentials;
CREATE POLICY ai_provider_credentials_tenant_isolation
    ON ai_provider_credentials
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- =====================================================================
--  STEP 2 , WHO IS RUNNING THIS
-- =====================================================================
--  Read this row before reading anything below it. If is_superuser or
--  bypasses_rls is true, step 0 has been edited out and the rest of this
--  file is decoration.

SELECT current_user                                                  AS running_as,
       (SELECT rolsuper     FROM pg_roles WHERE rolname=current_user) AS is_superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypasses_rls,
       (SELECT relrowsecurity AND relforcerowsecurity
          FROM pg_class WHERE relname='ai_provider_credentials')      AS enabled_and_forced;


-- =====================================================================
--  STEP 3 , THE WRITES THAT MUST WORK
-- =====================================================================

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('11111111-1111-1111-1111-111111111111','groq');
SELECT 'A stored its own key' AS step, count(*) AS rows_a_sees FROM ai_provider_credentials;
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('22222222-2222-2222-2222-222222222222','cerebras');
SELECT 'B stored its own key' AS step, count(*) AS rows_b_sees FROM ai_provider_credentials;
COMMIT;


-- =====================================================================
--  STEP 4 , THE HEADLINE: B HOLDS A'S TENANT ID AND CAN DO NOTHING WITH IT
-- =====================================================================
--  Each of the next four must refuse or return zero. Run them one at a
--  time and read the error text: an INSERT raises, a SELECT and a DELETE
--  do not, and the difference is the point. A write that is refused
--  raises 42501 and somebody sees a stack trace; a read that is refused
--  RETURNS NOTHING, so the screen is merely empty and the product looks
--  unpopulated rather than broken.

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
-- MUST RAISE: new row violates row-level security policy
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('11111111-1111-1111-1111-111111111111','mistral');
ROLLBACK;

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
-- MUST RETURN 0
SELECT 'B reading A' AS step, count(*) AS a_rows_visible_to_b
  FROM ai_provider_credentials
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
-- MUST DELETE 0
WITH d AS (DELETE FROM ai_provider_credentials
            WHERE tenant_id = '11111111-1111-1111-1111-111111111111' RETURNING 1)
SELECT 'B deleting A' AS step, count(*) AS a_rows_b_deleted FROM d;
COMMIT;

-- MUST RETURN 0. No tenant set at all is the case a forgotten
-- withTenant() produces, and it must see nothing rather than everything.
SELECT 'no tenant set' AS step, count(*) AS rows_visible FROM ai_provider_credentials;


-- =====================================================================
--  STEP 5 , THE CLOUDFLARE PAIR
-- =====================================================================
--  With a token and no account id, lib/ai/client.ts builds
--    https://api.cloudflare.com/client/v4/accounts//ai/v1
--  every call fails, the router walks on, and nothing reports why. Three
--  places refuse it; this is the last one.

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
-- MUST RAISE: violates check constraint ..._cloudflare_needs_account
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('11111111-1111-1111-1111-111111111111','cloudflare_workers_ai');
ROLLBACK;

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
-- MUST SUCCEED. The pairing with the refusal above is what separates
-- "the constraint works" from "the table rejects everything".
INSERT INTO ai_provider_credentials (tenant_id, provider_id, account_id)
VALUES ('11111111-1111-1111-1111-111111111111','cloudflare_workers_ai','acct-1');
COMMIT;

-- MUST RAISE: whitespace is not an account id.
BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
INSERT INTO ai_provider_credentials (tenant_id, provider_id, account_id)
VALUES ('22222222-2222-2222-2222-222222222222','cloudflare_workers_ai','   ');
ROLLBACK;


-- =====================================================================
--  STEP 6 , ONE ROW PER PROVIDER, AND A STATUS FROM THE LIST
-- =====================================================================

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
-- MUST RAISE: duplicate key value violates ..._provider_key.
-- Two rows would mean two vault secrets under two owner ids and a
-- resolver picking one by created_at, which is the shape where rotating
-- a key leaves the old one live and nobody can tell which is in use.
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('11111111-1111-1111-1111-111111111111','groq');
ROLLBACK;

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
-- MUST SUCCEED: the SAME provider id ('groq') under a DIFFERENT
-- workspace. The unique index is (tenant_id, provider_id), not global,
-- and a drill that only showed the refusal above could not tell a
-- per-tenant index from a global one.
INSERT INTO ai_provider_credentials (tenant_id, provider_id)
VALUES ('22222222-2222-2222-2222-222222222222','groq');
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
-- MUST RAISE: violates check constraint ..._status_valid
INSERT INTO ai_provider_credentials (tenant_id, provider_id, status)
VALUES ('11111111-1111-1111-1111-111111111111','mistral','definitely_fine');
ROLLBACK;

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
-- MUST RAISE: violates check constraint ..._use_count_non_negative
INSERT INTO ai_provider_credentials (tenant_id, provider_id, use_count)
VALUES ('11111111-1111-1111-1111-111111111111','google_gemini', -1);
ROLLBACK;


-- =====================================================================
--  STEP 7 , THE VERDICT
-- =====================================================================
--  A holds two rows (groq, cloudflare_workers_ai) and B holds two
--  (cerebras, groq). Both hold a row for 'groq' and neither can see the
--  other's. Nothing A did reached B and nothing B did reached A.

BEGIN;
SELECT set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111', true);
SELECT 'A final' AS step, count(*) AS rows_a_sees FROM ai_provider_credentials;
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant_id','22222222-2222-2222-2222-222222222222', true);
SELECT 'B final' AS step, count(*) AS rows_b_sees FROM ai_provider_credentials;
COMMIT;
