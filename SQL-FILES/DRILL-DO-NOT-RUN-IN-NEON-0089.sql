-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates a role, a table, and TWO TENANTS' worth of lockout rows,
--  and it installs the BROKEN policy on purpose so the leak can be seen
--  happening. Throwaway Postgres only.
--
--     createdb drill0089
--     psql -q -d drill0089 -f DRILL-DO-NOT-RUN-IN-NEON-0089.sql
--
--  ⭐ ONE COMMAND, ONE SESSION, AND THE ASSERTIONS RUN UNDER `SET ROLE
--  lockdrill`. Row-level security is enforced against the CURRENT role,
--  not the session's login role, so a superuser who has SET ROLE to a
--  NOBYPASSRLS role is subject to every policy below — and `SET ROLE`
--  made outside a transaction survives the ROLLBACKs the refusals use.
--  The alternative (reconnect halfway through the file) means the second
--  connection re-runs the setup and drops the fixtures it is meant to be
--  reading. The guard in STEP 2 checks `current_user` after the switch,
--  so a file run without it stops rather than passing for free.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 WHAT THIS EXISTS TO PROVE, AND WHY VERIFY-0089 CANNOT
--  ══════════════════════════════════════════════════════════════════
--  `VERIFY-0089-neon-safe.sql` runs against the real database and is
--  therefore not allowed to invent two tenants, plant a row under each
--  and try to cross between them. It evaluates the live policy
--  predicates instead, which does catch this defect — but a boundary is
--  only truly proven by crossing it as the role that would cross it and
--  getting nothing back, and that needs rows only a throwaway database
--  may have.
--
--  0089 shipped with:
--
--      CREATE POLICY login_lockouts_write_platform ON login_lockouts
--        FOR ALL
--        USING (true)                        -- ← the leak
--        WITH CHECK (app_platform_scope());
--
--  ① PERMISSIVE POLICIES ARE OR'D TOGETHER. With the tenant read policy
--     alongside it, effective SELECT visibility became
--     `(tenant_id = mine) OR (true)` — every row, to everybody.
--  ② `FOR ALL` IS NOT "ALL WRITES". It supplies USING for SELECT,
--     UPDATE and DELETE, and WITH CHECK for INSERT and UPDATE.
--  ③ DELETE IS CHECKED AGAINST USING AND HAS NO WITH CHECK, so the same
--     line also permitted destroying lockout evidence.
--
--  ⚠️ GRANTS ARE DELIBERATELY NOT UNDER TEST HERE. `lockdrill` owns the
--  table and holds every privilege on it, so nothing below can be
--  refused by a missing GRANT. Every refusal in this file is a POLICY
--  refusal, which is the only way to tell the isolation boundary from
--  the privilege list. VERIFY-0089 audits the grants separately.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE THING THAT MUST STILL WORK. A
--  drill that only shows refusals cannot tell "correctly isolated" from
--  "broken for everybody", and a table nobody can read at all passes
--  every refusal here.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;


-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM ALL-IN-ONE-SETUP AND 0089
-- =====================================================================
--
--  Only the parts 0089's policies actually read. `users` is stubbed
--  because 0089's `actor_user_id` FK needs the RELATION to exist — a
--  nullable FK does not change that, which is one of the false claims
--  this repair pass removed from 0089's header.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid;
$fn$;

CREATE OR REPLACE FUNCTION app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$fn$;

DROP TABLE IF EXISTS login_lockouts, users CASCADE;

CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE login_lockouts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL,
    failed_attempts int  NOT NULL DEFAULT 0,
    locked_until    timestamptz NULL,
    locked_reason   text,
    last_failure_at timestamptz NULL,
    tenant_id       uuid NULL,
    actor_user_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT login_lockouts_email_unique UNIQUE (email),
    CONSTRAINT login_lockouts_attempts_non_negative CHECK (failed_attempts >= 0)
);

-- The two workspaces this drill exists to keep apart, and the platform's
-- own unattributed evidence row. Seeded before RLS is switched on, by
-- the owner — the seed proves nothing on its own, it is the fixture the
-- proofs below read.
INSERT INTO login_lockouts (email, failed_attempts, tenant_id) VALUES
  ('a@tenant-a.example',      5, '11111111-1111-1111-1111-111111111111'),
  ('b@tenant-b.example',      5, '22222222-2222-2222-2222-222222222222'),
  ('nobody@platform.example', 5, NULL);

ALTER TABLE login_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_lockouts FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lockdrill') THEN
    CREATE ROLE lockdrill NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO lockdrill;
ALTER TABLE login_lockouts             OWNER TO lockdrill;
ALTER TABLE users                      OWNER TO lockdrill;
ALTER FUNCTION app_current_tenant_id() OWNER TO lockdrill;
ALTER FUNCTION app_platform_scope()    OWNER TO lockdrill;


-- =====================================================================
--  STEP 2 — BECOME THE ROLE THAT WOULD CROSS THE BOUNDARY
-- =====================================================================
SET ROLE lockdrill;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      '🔴 REFUSING: % bypasses RLS, so every refusal below would pass for the wrong reason.',
      current_user;
  END IF;
  RAISE NOTICE 'Assertions run as %, which bypasses nothing.', current_user;
END
$$;

\set ON_ERROR_STOP off

-- =====================================================================
--  PART A — THE LEAK, REPRODUCED. This is 0089 AS IT SHIPPED.
-- =====================================================================
DROP POLICY IF EXISTS login_lockouts_read_tenant    ON login_lockouts;
DROP POLICY IF EXISTS login_lockouts_write_platform ON login_lockouts;

CREATE POLICY login_lockouts_read_tenant ON login_lockouts
    FOR SELECT
    USING (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id());

CREATE POLICY login_lockouts_write_platform ON login_lockouts
    FOR ALL
    USING (true)                      -- 🔴 THE DEFECT, ON PURPOSE
    WITH CHECK (app_platform_scope());

-- ---------------------------------------------------------------------
--  🔴 A-1 — TENANT A READS TENANT B. The whole table, in fact.
--     ⚠️ THIS IS THE BUG. It is here so the reader sees the number 3
--     with their own eyes before seeing it become 1 in PART B.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) AS a_sees_this_many_rows_leak_if_not_1 FROM login_lockouts;
  SELECT email    AS a_can_read_bs_email_leak FROM login_lockouts
   WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
COMMIT;
-- EXPECT (broken): 3, and 'b@tenant-b.example' — THE LEAK

-- ---------------------------------------------------------------------
--  🔴 A-2 — AND TENANT A CAN DESTROY THE EVIDENCE. DELETE has no
--     WITH CHECK; `USING (true)` is the only clause it is judged on.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  DELETE FROM login_lockouts WHERE email = 'b@tenant-b.example';
ROLLBACK;
-- EXPECT (broken): DELETE 1 — evidence about another workspace, gone


-- =====================================================================
--  PART B — THE REPAIR. This is 0089 AS IT NOW SHIPS.
-- =====================================================================
DROP POLICY IF EXISTS login_lockouts_write_platform ON login_lockouts;

CREATE POLICY login_lockouts_write_platform ON login_lockouts
    FOR ALL
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 1 — TENANT A STILL SEES ITS OWN ATTRIBUTED ROW.
--     🔴 The pairing that matters. A policy that returns nothing to
--     anybody passes every refusal below and is not a fix.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) AS a_sees_exactly_1 FROM login_lockouts;
  SELECT email    AS and_it_is_as_own FROM login_lockouts;
COMMIT;
-- EXPECT: 1, 'a@tenant-a.example'

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 1 — TENANT A CANNOT SEE TENANT B ANY MORE.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) AS must_be_zero FROM login_lockouts
   WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
COMMIT;
-- EXPECT: 0

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 2 — NOR THE PLATFORM'S UNATTRIBUTED EVIDENCE. A credential
--     attack with no workspace behind it is nobody's tenant data.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) AS must_be_zero FROM login_lockouts WHERE tenant_id IS NULL;
COMMIT;
-- EXPECT: 0

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 3 — A CONNECTION THAT FORGOT TO SCOPE AT ALL SEES NOTHING.
--     ⚠️ THIS IS WHY `lib/security/lockout.ts` HAD TO CHANGE IN THE SAME
--     BREATH. Its two reads used the unscoped module client; they
--     "worked" only because PART A's `USING (true)` showed them
--     everything. Against this policy an unscoped read returns zero
--     rows, `isLocked()` answers "not locked" for every account in the
--     world, and — because the module's catch block degrades to "not
--     locked" by design — nothing anywhere reports it.
-- ---------------------------------------------------------------------
SELECT count(*) AS unscoped_must_be_zero FROM login_lockouts;
-- EXPECT: 0

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 4 — AND TENANT A CANNOT DELETE ANY OF IT.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  DELETE FROM login_lockouts WHERE email = 'b@tenant-b.example';
  DELETE FROM login_lockouts WHERE email = 'a@tenant-a.example';
ROLLBACK;
-- EXPECT: DELETE 0, DELETE 0 — nothing matched, nothing destroyed

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 2 — THE PLATFORM STILL READS EVERYTHING, which is what
--     the lockout module does under `withPlatformScope`.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  SELECT count(*) AS platform_sees_3 FROM login_lockouts;
COMMIT;
-- EXPECT: 3

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 3 — A PLATFORM INSERT STILL SUCCEEDS. The lockout API
--     writes here on every failed sign-in; if this stopped working the
--     evidence table would silently stop filling.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  INSERT INTO login_lockouts (email, failed_attempts) VALUES ('new@platform.example', 1);
COMMIT;
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 4 — AND A PLATFORM UPDATE, which is how the counter is
--     bumped and how an administrator releases a lock.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  UPDATE login_lockouts SET failed_attempts = 2 WHERE email = 'new@platform.example';
COMMIT;
-- EXPECT: UPDATE 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 5 — AN UNSCOPED WRITE IS STILL REFUSED OUTRIGHT.
--     ⚠️ Note the ASYMMETRY that makes reads the dangerous half: this
--     one raises 42501 and somebody sees a stack trace. REFUSAL 3
--     returned an empty answer and looked like a working feature.
-- ---------------------------------------------------------------------
INSERT INTO login_lockouts (email, failed_attempts) VALUES ('forgot@scope.example', 1);
-- EXPECT: ERROR 42501 new row violates row-level security policy

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 6 — AND A TENANT SESSION CANNOT FORGE ONE FOR ITSELF.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO login_lockouts (email, failed_attempts, tenant_id)
  VALUES ('forged@tenant.example', 1, '11111111-1111-1111-1111-111111111111');
ROLLBACK;
-- EXPECT: ERROR 42501

\set ON_ERROR_STOP on
RESET ROLE;

-- =====================================================================
--  SUMMARY OF WHAT MUST HAVE HAPPENED
-- =====================================================================
--   PART A (the defect, on purpose)
--     A-1 returned 3 and leaked b@tenant-b.example  ← the bug, seen
--     A-2 deleted another workspace's evidence      ← the bug, seen
--
--   PART B (as 0089 now ships)
--     POSITIVE 1  tenant A saw exactly its own 1 row
--     REFUSAL 1   tenant B's row: 0
--     REFUSAL 2   platform evidence: 0
--     REFUSAL 3   unscoped read: 0
--     REFUSAL 4   DELETE 0, DELETE 0
--     POSITIVE 2  platform read: 3
--     POSITIVE 3  platform INSERT succeeded
--     POSITIVE 4  platform UPDATE succeeded
--     REFUSAL 5   42501
--     REFUSAL 6   42501
--
--  ⚠️ IF A PART B REFUSAL SUCCEEDED, STOP. The most likely cause is a
--  role that bypasses RLS, which the guard in STEP 2 was supposed to
--  catch.
--  ⚠️ IF A PART B POSITIVE FAILED, STOP TOO — the policy is not "safe",
--  it is broken, and a table nobody can read is not tenant isolation.
-- =====================================================================
