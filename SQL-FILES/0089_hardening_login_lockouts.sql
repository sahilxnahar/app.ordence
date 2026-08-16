-- ############################################################################
-- 0089 — LOGIN LOCKOUT EVIDENCE TABLE (Hardening II / v1.50.0-alpha)
-- ############################################################################
--
-- PURPOSE
-- -------
-- Clerk enforces failed-attempt lockouts natively on the hosted sign-in
-- page, but the platform keeps its own evidence copy because three things
-- the hosted widget cannot do must be true of this workspace:
--
--   1. A lockout decision must be RE-CHECKABLE by any surface the platform
--      owns (API clients, portal URLs, worker retries) with a database
--      fact, not by trusting a third-party widget's memory.
--   2. A lockout must be EVIDENCE: who was locked, when, after how many
--      failures, and when it expires — because the security census asked
--      for lock accounts after failed logins, and a decision with no
--      record is a decision that cannot be audited.
--   3. A lockout must SURVIVE a Clerk project reconfiguration. If someone
--      lowers the hosted limit, our table is the floor.
--
-- This table is the RECORD. Enforcement at the edge is in
-- lib/security/lockout.ts (see Wave 8 build notes).
--
-- RUN ORDER
-- ---------
-- Glob-sorted after 0088, AND IT HAS REAL PREDECESSORS. This header used
-- to say the file "stands on its own" and could run before or after 0003
-- "because the FK is NULLABLE". That is wrong twice over:
--
--   ⚠️ A NULLABLE FK STILL NEEDS ITS TARGET TABLE TO EXIST. `REFERENCES
--      users(id)` is resolved at CREATE TABLE time, not at INSERT time.
--      Nullability decides whether a ROW may omit the reference; it says
--      nothing about whether the referenced RELATION has to be there.
--      Run this before 0003 and you get 42P01 on `users`.
--   ⚠️ THE CHANGE-LOG TRIGGER NEEDS `record_change()`, which 0017
--      creates. See the note above that trigger.
--
-- 🔴 SO: 0003 (users) and 0017 (record_change) MUST BE APPLIED FIRST,
-- along with the core roles and `app_platform_scope()` /
-- `app_current_tenant_id()` from ALL-IN-ONE-SETUP.sql. The normal run
-- order already satisfies all of this; the point of writing it down is
-- that a partial-restore or a fresh local base does not.
--
-- IDEMPOTENCY
-- -----------
-- CREATE TABLE IF NOT EXISTS + role-existence guards. The REVOKE/GRANT
-- block only runs when the role exists, and never errors when nothing
-- changed. Safe to run on every deploy.
--
-- NEON SAFETY
-- -----------
-- ⚠️ THE SENTENCE THAT USED TO OPEN THIS PARAGRAPH WAS FOLKLORE.
-- It said "Postgres allows exactly one ALTER TYPE ... ADD VALUE per
-- transaction". There is no such limit and there never was. The real
-- historical restriction, lifted in PG12, was that `ALTER TYPE ... ADD
-- VALUE` could not run INSIDE A TRANSACTION BLOCK AT ALL — and even on
-- PG12+ a newly added value cannot be USED in the same transaction that
-- added it (unless the type itself was created there). Repeating the
-- wrong rule teaches the next person to split files for no reason and,
-- worse, to believe two additions in one file are the dangerous case
-- when the dangerous case is using a value you just added.
--
-- ⭐ NONE OF IT APPLIES HERE: this file has no enum changes at all. It
-- is one CREATE TABLE plus triggers, RLS and grants, in one transaction,
-- all idempotent. Safe to run against Neon. No DRILL file touches this
-- migration; the two-tenant proof lives in
-- DRILL-DO-NOT-RUN-IN-NEON-0089.sql and creates its own throwaway
-- tenants, which is why it must never be pointed at Neon.

BEGIN;

-- citext lives in the postgres-contrib extension; the base image ships it,
-- but a bare `psql -f` run against an untouched local database needs this.
CREATE EXTENSION IF NOT EXISTS citext;

-- ======================================================================
-- TABLE
-- ======================================================================
CREATE TABLE IF NOT EXISTS login_lockouts (
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

COMMENT ON TABLE login_lockouts IS
    'Platform evidence of credential-attack lockouts. One row per failing
     identifier. Rows are UPSERTED by the lockout API; they are never
     silently deleted — a lockout that ended must still exist for audit.';

COMMENT ON COLUMN login_lockouts.locked_until IS
    'NULL means "not currently locked". A non-NULL value in the past means
     the lockout expired; the API clears it (and resets the counter) on
     the next successful release. Both states are evidence.';

-- ======================================================================
-- TRIGGER — updated_at maintenance
-- ======================================================================
CREATE OR REPLACE FUNCTION login_lockouts_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS login_lockouts_touch_updated_at ON login_lockouts;
CREATE TRIGGER login_lockouts_touch_updated_at
    BEFORE UPDATE ON login_lockouts
    FOR EACH ROW EXECUTE FUNCTION login_lockouts_touch_updated_at();

-- ======================================================================
-- TRIGGER — change log (the same coverage every tenant-scoped table gets)
-- ======================================================================
-- ⚠️ THERE IS NO GUARD HERE, AND THE COMMENT THAT CLAIMED ONE WAS THE
-- WHOLE PROBLEM. It read "`record_change()` exists only after 0017 has
-- run; the guard below makes this file safe to apply on a fresh base" —
-- but the CREATE TRIGGER below is unconditional. On a base where 0017
-- has not run, `record_change()` does not exist and this statement
-- raises 42883, aborting the transaction and leaving NONE of this file
-- applied. A reader who trusted that sentence would have skipped the one
-- check that mattered.
--
-- 🔴 THE REAL REQUIREMENT, STATED PLAINLY: APPLY 0017 BEFORE THIS FILE.
-- That is the run order in SQL-RUN-ORDER, so the ordinary path is fine.
-- The trigger is left unconditional on purpose — an evidence table that
-- silently loses its change log is worse than a deploy that stops and
-- says which migration is missing.
DROP TRIGGER IF EXISTS login_lockouts_change_log ON login_lockouts;
CREATE TRIGGER login_lockouts_change_log
    AFTER INSERT OR UPDATE OR DELETE ON login_lockouts
    FOR EACH ROW EXECUTE FUNCTION record_change();

-- ======================================================================
-- RLS
-- ======================================================================
ALTER TABLE login_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_lockouts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS login_lockouts_read_tenant ON login_lockouts;
DROP POLICY IF EXISTS login_lockouts_write_platform ON login_lockouts;

-- Reads: the workspace that a row is attributed to may read its own
-- rows; unattributed rows (platform evidence, no tenant) are invisible
-- to every tenant — they belong to the platform, like security_events.
CREATE POLICY login_lockouts_read_tenant ON login_lockouts
    FOR SELECT
    USING (
        tenant_id IS NOT NULL
        AND tenant_id = app_current_tenant_id()
    );

-- Writes: opt-in platform scope. Nobody writes this table by accident
-- (no tenant context, no forgotten flag) — setting the platform flag
-- requires the same deliberate marker every other evidence table asks
-- for. Lockout rows are never tenant-authored: a lockout is a platform
-- decision about a credential attack, and attribution happens later.
--
-- 🔴🔴 `USING` MUST BE `app_platform_scope()`, NOT `true`, AND THIS WAS
-- PROVED ON A REAL POSTGRES, NOT REASONED ABOUT.
--
-- This clause read `USING (true)`. Three facts combine into a full
-- cross-tenant read of this table:
--
--   ① PERMISSIVE POLICIES ARE OR'D. `login_lockouts_read_tenant` and
--      this one are both PERMISSIVE (the default), so effective SELECT
--      visibility is `(tenant_id = mine) OR (true)` — which is every
--      row, for every role, regardless of the tenant pinned.
--   ② `FOR ALL` COVERS SELECT. It is not "all writes". A `FOR ALL`
--      policy supplies the USING clause for SELECT, UPDATE and DELETE
--      and the WITH CHECK clause for INSERT and UPDATE. Judging this
--      policy by its WITH CHECK alone — which is what the old
--      VERIFY-0089 did — never looks at the clause that leaked.
--   ③ DELETE IS CHECKED AGAINST `USING`, and has no WITH CHECK at all.
--      So `USING (true)` also permitted deleting evidence rows. The
--      column grants below stop `ordence_app` specifically, but the
--      policy is the isolation boundary and it said yes.
--
-- ⚠️ THE FIX IS NOT "ADD A TENANT PREDICATE". These rows are platform
-- evidence and mostly have `tenant_id IS NULL`; a tenant predicate would
-- hide them from the platform too. The right answer is that this policy
-- grants exactly what its name says — platform scope — on BOTH clauses,
-- and the tenant read policy above continues to serve attributed rows.
-- With this in place a session pinned to tenant A sees only tenant A's
-- attributed row, and a platform-scoped INSERT still succeeds. Both
-- halves are exercised in DRILL-DO-NOT-RUN-IN-NEON-0089.sql.
CREATE POLICY login_lockouts_write_platform ON login_lockouts
    FOR ALL
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());

-- ======================================================================
-- GRANTS — REVOKE FIRST, exactly as 0087 does it
-- ======================================================================
DO
$$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        -- The lockout API is the only writer. The role needs SELECT to
        -- re-check a lockout decision on its own surfaces (middleware,
        -- worker retries) and INSERT/UPDATE to keep the counter.
        --
        -- ⭐ GRANTS AND POLICIES ARE TWO SEPARATE GATES AND BOTH MUST
        -- SAY YES. These grants decide what the ROLE may attempt; the
        -- policies above decide which ROWS it then sees or writes. With
        -- `USING (app_platform_scope())` on the platform policy, a
        -- connection with no platform marker and no tenant pinned sees
        -- nothing here at all — which is why `lib/security/lockout.ts`
        -- wraps EVERY statement, reads included, in `withPlatformScope`.
        --
        -- ⚠️ NO DELETE GRANT, ON PURPOSE. An ended lockout is still
        -- evidence. The policy would also refuse it without the platform
        -- marker, but a grant that was never issued cannot be the thing
        -- a future policy edit accidentally re-enables.
        REVOKE ALL ON login_lockouts FROM ordence_app;
        GRANT SELECT ON login_lockouts TO ordence_app;
        GRANT INSERT (email, failed_attempts, locked_until, locked_reason,
                      last_failure_at, tenant_id, actor_user_id)
            ON login_lockouts TO ordence_app;
        GRANT UPDATE (failed_attempts, locked_until, locked_reason,
                      last_failure_at, tenant_id, actor_user_id)
            ON login_lockouts TO ordence_app;
    END IF;
END
$$;

COMMIT;
