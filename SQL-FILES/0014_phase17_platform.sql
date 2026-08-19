-- ============================================================================
-- Ordence — Phases 17 & 18: The Super Admin Console
-- Version: v0.14.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the five platform tables:
--   platform_staff, platform_impersonation_sessions, tenant_support_consents,
--   platform_tenant_flags, platform_action_log
-- (and the six enums: platform_grade, platform_staff_status,
--  impersonation_mode, impersonation_scope, impersonation_end_reason,
--  support_consent_mode)
--
-- Contents:
--   1. Row-Level Security — three different policy SHAPES, one per purpose
--   2. Impersonation evidence is WRITE-ONCE (one-way close, never deleted)
--   3. The platform action log is APPEND-ONLY
--   4. Consent cannot be manufactured by the platform, or un-revoked
--   5. The impersonation DELETE guard on tenant data
--   6. ⭐ THE PLATFORM READ SCOPE — and the data-protection line, in SQL
--   7. Integrity constraints the application also checks
--   8. Grants — REVOKE first
--   9. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Every other migration in this repository exists to make cross-tenant access
-- IMPOSSIBLE. This one describes the machinery that deliberately crosses that
-- boundary, which makes these five tables the highest-value target in the
-- database — and it changes what "protecting" them means.
--
-- Elsewhere the threat is a bug in our application handing tenant A's rows to
-- tenant B. Here the realistic threat is an INSIDER: somebody who is supposed
-- to be able to read this data, editing the record of what they read.
--
-- So the controls below are not about isolation between customers. They are
-- about making the evidence unfalsifiable:
--
--   • An impersonation record cannot be edited (except a one-way close) and
--     cannot be deleted — not by the application role, not by the table owner.
--     Section 2.
--   • The cross-tenant access log cannot be edited or deleted at all.
--     Section 3.
--   • A tenant's consent cannot be INSERTED by the platform connection. Not
--     "should not" — the RLS WITH CHECK makes it impossible, so "they
--     consented" is a claim only the customer's own session can make.
--     Sections 1 and 4.
--   • Nothing can be DELETED from a customer's workspace while an
--     impersonation is in progress, even if the application forgets to check.
--     Section 5.
--
-- The application checks all of these too. That is not redundancy for its own
-- sake — the app check produces a good error message, the database check is
-- the one that is actually true.
-- ============================================================================


-- The tenant-context accessor. Idempotent; also created by earlier phases.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- THE IMPERSONATION CONTEXT ACCESSOR
-- ---------------------------------------------------------------------------
-- Mirrors `app_current_tenant_id()` exactly, including the fail-closed NULL:
-- an unset or empty setting reads as NULL, which every guard below treats as
-- "nobody is impersonating".
--
-- ⚠️ IT IS NOT SET BY ANYTHING YET. `withTenant()` in db/index.ts pins the
-- tenant id and nothing else, and this phase does not own that file. Until
-- INTEGRATION step 2 in docs/PHASE-17-18-NOTES.md is applied, the guard in
-- Section 5 is armed but never fires. That is stated here rather than left
-- for someone to discover from a test that passes for the wrong reason.
CREATE OR REPLACE FUNCTION app_current_impersonation_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.impersonation_id', true), '')::uuid;
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
-- THREE POLICY SHAPES, AND THE REASON EACH ONE IS DIFFERENT
-- ---------------------------------------------------------------------------
-- Most tables in this platform share one policy shape. These do not, and the
-- differences are the design rather than an inconsistency:
--
--   SHAPE A — PLATFORM ONLY          (platform_staff, platform_action_log)
--     USING / WITH CHECK: app_current_tenant_id() IS NULL
--     A tenant session ALWAYS has a tenant id pinned, so it matches nothing.
--     Not "sees fewer rows" — sees zero, and can write none.
--
--   SHAPE B — PLATFORM WRITES, TENANT READS   (platform_tenant_flags,
--                                              platform_impersonation_sessions)
--     USING:      tenant_id = app_current_tenant_id() OR context IS NULL
--     WITH CHECK: app_current_tenant_id() IS NULL
--     The customer can SEE their own flags (the app must, to render) and can
--     SEE who entered their workspace (transparency they are entitled to),
--     and can write neither. The asymmetry is deliberate and is the whole
--     point of the shape.
--
--   SHAPE C — TENANT WRITES, PLATFORM READS   (tenant_support_consents)
--     USING:      tenant_id = app_current_tenant_id() OR context IS NULL
--     WITH CHECK: tenant_id = app_current_tenant_id()
--     ⭐ THE MOST IMPORTANT POLICY IN THIS FILE. The platform-scoped
--     connection (context NULL) can read consent and CANNOT INSERT IT. So
--     "the customer consented" is a statement only the customer's own
--     session is capable of making. Consent we could write ourselves would
--     not be consent, and no amount of application code could fix that.
-- ---------------------------------------------------------------------------

-- ---- SHAPE A: platform_staff ---------------------------------------------
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_staff_platform_only ON platform_staff;
CREATE POLICY platform_staff_platform_only ON platform_staff
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE A: platform_action_log ----------------------------------------
ALTER TABLE platform_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_action_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_action_log_platform_only ON platform_action_log;
CREATE POLICY platform_action_log_platform_only ON platform_action_log
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE B: platform_impersonation_sessions ----------------------------
--
-- A customer being able to read the record of every time we entered their
-- workspace — who, when, under what authority, with what written reason — is
-- not a concession. It is the single most persuasive answer to the question
-- every enterprise security review asks, and it costs one OR clause.
ALTER TABLE platform_impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_impersonation_sessions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_sessions_visibility ON platform_impersonation_sessions;
CREATE POLICY impersonation_sessions_visibility ON platform_impersonation_sessions
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE B: platform_tenant_flags --------------------------------------
ALTER TABLE platform_tenant_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_tenant_flags FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_tenant_flags_visibility ON platform_tenant_flags;
CREATE POLICY platform_tenant_flags_visibility ON platform_tenant_flags
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE C: tenant_support_consents ------------------------------------
ALTER TABLE tenant_support_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_support_consents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_support_consents_visibility ON tenant_support_consents;
CREATE POLICY tenant_support_consents_visibility ON tenant_support_consents
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — IMPERSONATION EVIDENCE IS WRITE-ONCE
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   The impersonation row is the only durable proof of what happened. If it
--   can be edited, it proves nothing — it only shows what somebody was later
--   willing to say. And the person with the strongest motive to edit it is
--   the operator whose access is being questioned, who by definition has
--   application credentials.
--
--   The specific rewrites this prevents, all of which look innocuous in a
--   diff and all of which destroy the record:
--     • extending `expires_at` so a 15-minute break-glass reads as an hour
--     • rewriting `justification` after the customer complains
--     • changing `mode` from `break_glass` to `standing_consent`
--     • moving `tenant_id` to a workspace where the access was authorised
--     • re-opening a closed session, or closing it with a different reason
--     • deleting the row entirely
--
-- THE FIX — a one-way close, and nothing else:
--   UPDATE is permitted ONLY when `ended_at` was NULL and is being set, and
--   ONLY when every other column is unchanged. `blocked_action_count` and
--   `action_count` are the two exceptions (they are counters the application
--   increments), and `tenant_notified_at` may be set once. DELETE is refused
--   outright.
--
--   This is the same pattern as issued invoices in Phase 11 (Section 4 of
--   0009): freeze the record, allow exactly one forward transition.
--
--   SQLSTATE 42501 is raised deliberately so the application can distinguish
--   this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_impersonation_tamper()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'platform_impersonation_sessions is evidence and cannot be deleted. '
      'Session % concerns tenant %.',
      OLD.id, OLD.tenant_id
      USING ERRCODE = '42501';
  END IF;

  -- A closed session is closed forever. Re-opening it, or re-closing it with
  -- a different reason, would let an operator rewrite the duration of their
  -- own access.
  IF OLD.ended_at IS NOT NULL AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason
  ) THEN
    RAISE EXCEPTION
      'Impersonation session % is already closed; its end cannot be changed.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- ⭐ THE FROZEN COLUMNS. Everything that answers who, which workspace,
  -- under what authority, and until when.
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.tenant_id         IS DISTINCT FROM OLD.tenant_id
  OR NEW.tenant_slug       IS DISTINCT FROM OLD.tenant_slug
  OR NEW.staff_id          IS DISTINCT FROM OLD.staff_id
  OR NEW.actor_clerk_id    IS DISTINCT FROM OLD.actor_clerk_id
  OR NEW.actor_email       IS DISTINCT FROM OLD.actor_email
  OR NEW.mode              IS DISTINCT FROM OLD.mode
  OR NEW.scope             IS DISTINCT FROM OLD.scope
  OR NEW.consent_id        IS DISTINCT FROM OLD.consent_id
  OR NEW.justification     IS DISTINCT FROM OLD.justification
  OR NEW.subject_user_id   IS DISTINCT FROM OLD.subject_user_id
  OR NEW.started_at        IS DISTINCT FROM OLD.started_at
  OR NEW.expires_at        IS DISTINCT FROM OLD.expires_at
  OR NEW.ip_address        IS DISTINCT FROM OLD.ip_address
  OR NEW.user_agent        IS DISTINCT FROM OLD.user_agent
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Impersonation evidence is immutable. Only ended_at/ended_reason, the '
      'action counters and tenant_notified_at may change on session %.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- The notification stamp is write-once too: "we told the customer" must
  -- not be removable, and re-stamping it would hide a delay.
  IF OLD.tenant_notified_at IS NOT NULL
     AND NEW.tenant_notified_at IS DISTINCT FROM OLD.tenant_notified_at THEN
    RAISE EXCEPTION
      'tenant_notified_at is write-once on session %.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS impersonation_no_delete ON platform_impersonation_sessions;
CREATE TRIGGER impersonation_no_delete
  BEFORE DELETE ON platform_impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_tamper();

DROP TRIGGER IF EXISTS impersonation_freeze ON platform_impersonation_sessions;
CREATE TRIGGER impersonation_freeze
  BEFORE UPDATE ON platform_impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_tamper();


-- ############################################################################
-- SECTION 3 — THE PLATFORM ACTION LOG IS APPEND-ONLY
-- ############################################################################
--
-- This table records "an operator searched every workspace for an email
-- address" and "an operator was granted access to every customer's data".
-- A DELETE privilege on it is, functionally, an "erase the record of what I
-- looked at" privilege — the same argument as `security_events` in Phase 20,
-- with the aggravating detail that the people with access to this table are
-- the people it is about.
--
-- Corrections are made by INSERTING a correcting row, which is what an
-- append-only log is for.

CREATE OR REPLACE FUNCTION prevent_platform_action_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'platform_action_log is append-only. % is not permitted on the '
    'cross-tenant access log.',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS platform_action_log_no_update ON platform_action_log;
CREATE TRIGGER platform_action_log_no_update
  BEFORE UPDATE ON platform_action_log
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_action_log_mutation();

DROP TRIGGER IF EXISTS platform_action_log_no_delete ON platform_action_log;
CREATE TRIGGER platform_action_log_no_delete
  BEFORE DELETE ON platform_action_log
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_action_log_mutation();


-- ############################################################################
-- SECTION 4 — CONSENT INTEGRITY
-- ############################################################################
--
-- Section 1 already makes it impossible for the platform connection to INSERT
-- a consent row. This section closes the two remaining ways a consent record
-- could be made to say something it did not:
--
--   • back-dating or re-writing a consent after the fact
--   • un-revoking one the customer withdrew
--
-- Note what is NOT forbidden: revoking. A customer must always be able to
-- withdraw consent, instantly, without asking anybody.

CREATE OR REPLACE FUNCTION protect_support_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Support consent records are evidence and cannot be deleted. '
      'Revoke instead (set revoked_at).'
      USING ERRCODE = '42501';
  END IF;

  -- Revocation is one-way. A consent the customer withdrew cannot be
  -- silently restored — they would have to grant a new one, which creates a
  -- new row with a new timestamp and a new actor.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION
      'Support consent % was revoked and cannot be un-revoked.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id          IS DISTINCT FROM OLD.tenant_id
  OR NEW.mode               IS DISTINCT FROM OLD.mode
  OR NEW.scope              IS DISTINCT FROM OLD.scope
  OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
  OR NEW.granted_by_email   IS DISTINCT FROM OLD.granted_by_email
  OR NEW.granted_at         IS DISTINCT FROM OLD.granted_at
  OR NEW.expires_at         IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION
      'What was consented to cannot be changed after the fact (consent %). '
      'Grant a new consent instead.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_consent_no_delete ON tenant_support_consents;
CREATE TRIGGER support_consent_no_delete
  BEFORE DELETE ON tenant_support_consents
  FOR EACH ROW EXECUTE FUNCTION protect_support_consent();

DROP TRIGGER IF EXISTS support_consent_freeze ON tenant_support_consents;
CREATE TRIGGER support_consent_freeze
  BEFORE UPDATE ON tenant_support_consents
  FOR EACH ROW EXECUTE FUNCTION protect_support_consent();


-- ############################################################################
-- SECTION 5 — THE IMPERSONATION DELETE GUARD
-- ############################################################################
--
-- ⭐ THE ONE CONTROL IN THIS PHASE THAT DOES NOT DEPEND ON APPLICATION CODE
-- ---------------------------------------------------------------------------
-- `lib/platform/impersonation-policy.ts` forbids an impersonator from
-- deleting anything, and `assertImpersonationAllows()` enforces it. Both live
-- in TypeScript, and both are only as good as the developer who remembers to
-- call the gate at the top of the next action they write. In eighteen months
-- somebody will not.
--
-- Deletion is the one forbidden operation the customer cannot undo and cannot
-- even detect — a deleted contact leaves no trace in their UI. So it gets a
-- second enforcement point, in the database, that no application refactor can
-- forget:
--
--     if an impersonation context is set, DELETE is refused. Full stop.
--
-- The guard is a NO-OP when nobody is impersonating: `app.impersonation_id`
-- is unset, the accessor returns NULL, and the row deletes normally. The cost
-- is one function call per deleted row on the guarded tables.
--
-- ⚠️ IT IS ARMED BUT NOT YET LOADED. Nothing sets `app.impersonation_id` —
-- `withTenant()` pins only the tenant id, and this phase does not own
-- db/index.ts. INTEGRATION step 2 in docs/PHASE-17-18-NOTES.md is the
-- three-line change that makes this fire. Until then the guard is inert and
-- the TypeScript policy is the only enforcement. Said plainly here because a
-- control everyone believes is live is worse than one everyone knows is not.

CREATE OR REPLACE FUNCTION refuse_delete_under_impersonation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF app_current_impersonation_id() IS NOT NULL THEN
    RAISE EXCEPTION
      'Deletion is not permitted while impersonating a customer (session %). '
      'Support may diagnose; only the customer may destroy their own records.',
      app_current_impersonation_id()
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

-- Applied to the tables holding customer records and money. Written as a loop
-- over a list with a `to_regclass` existence check so this file stays runnable
-- against a database where a later phase's tables do not exist yet.
DO $$
DECLARE
  guarded text;
BEGIN
  FOREACH guarded IN ARRAY ARRAY[
    -- Customer records
    'contacts', 'companies', 'deals', 'custom_object_records',
    'assets', 'documents', 'contracts', 'contract_versions',
    -- Financial history
    'journal_entries', 'transactions', 'ledgers',
    -- Money
    'subscriptions', 'invoices', 'invoice_lines', 'payment_methods',
    -- Access
    'users', 'user_roles', 'roles', 'portal_links'
  ]
  LOOP
    IF to_regclass('public.' || guarded) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I', 'no_delete_under_impersonation', guarded
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION refuse_delete_under_impersonation()',
        'no_delete_under_impersonation', guarded
      );
    END IF;
  END LOOP;
END
$$;


-- ############################################################################
-- SECTION 6 — THE PLATFORM READ SCOPE
-- ############################################################################
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ READ THIS SECTION IN FULL. IT DOCUMENTS A PRE-EXISTING BUG AND FIXES IT
--    IN THE ONLY WAY THAT DOES NOT WIDEN THE BLAST RADIUS.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DISCOVERY
-- -------------
-- `withPlatformScope()` in db/index.ts is documented as "the escape hatch for
-- genuine platform-wide operations (super-admin tooling, cross-tenant billing
-- rollups)". It is not one. It runs on the ordinary `db` client with NO tenant
-- context, so `app_current_tenant_id()` returns NULL, and every tenant-scoped
-- policy in this database is a plain equality:
--
--     USING (tenant_id = app_current_tenant_id())
--
-- `tenant_id = NULL` evaluates to NULL, which is not TRUE, so the row is
-- filtered. Verified against PostgreSQL 16 as `ordence_app`, with data present:
--
--     SELECT count(*) FROM tenants;        -> 0
--     SELECT count(*) FROM users;          -> 0
--     SELECT count(*) FROM subscriptions;  -> 0
--
-- It fails CLOSED, which is the right direction and is why nothing has leaked.
-- But it means the escape hatch has never actually opened: any code that
-- relies on it silently sees an empty database. (The `OR (tenant_id IS NULL
-- AND app_current_tenant_id() IS NULL)` clauses on `payment_events` and
-- `security_events` are the exception that proves it — they were added so
-- platform tooling could read ORPHAN rows, and they grant nothing else.)
--
-- THE OBVIOUS FIX, AND WHY IT IS REFUSED
-- --------------------------------------
-- Adding `OR app_current_tenant_id() IS NULL` to the tenant policies would
-- make the console work in one line. It would also mean that ANY connection
-- that forgot to set a tenant context reads EVERY customer's data — turning
-- the single most valuable property in this codebase ("no context means zero
-- rows, never all rows", db/index.ts) into "no context means all rows". One
-- missed `withTenant()` would become a full breach instead of an empty page.
-- REJECTED, absolutely.
--
-- THE FIX APPLIED HERE
-- --------------------
-- An EXPLICIT, POSITIVE, transaction-local marker — `app.platform_scope` —
-- that a caller must deliberately set, exactly as `app.current_tenant_id` is
-- deliberately set. Absence means no access, so the fail-closed default is
-- untouched.
--
-- ⭐ AND — THE PART THAT MATTERS MOST — IT IS GRANTED PER TABLE.
--
-- This is where the data-protection line argued in
-- `lib/platform/search-scopes.ts` stops being a policy and becomes a
-- guarantee. The platform scope is added to the tables holding the
-- COMMERCIAL RELATIONSHIP:
--
--     tenants, users, subscriptions, invoices, documents (metadata)
--
-- and is DELIBERATELY NOT ADDED to the tables holding CUSTOMER CONTENT:
--
--     contacts, companies, deals, custom_object_records, contract_versions,
--     journal_entries, transactions
--
-- So a platform operator — at any grade, through any bug in the TypeScript,
-- with a fully working platform connection — reads ZERO rows from a
-- customer's contact list. Not "is not supposed to". Cannot. Seeing a
-- customer's record requires impersonation, which means a tenant context,
-- which means consent, a banner, an expiry and an audit row.
--
-- Verified in Section 9, Check 14, and in tests/security/platform-isolation.
--
-- ⚠️ NOTHING SETS `app.platform_scope` YET. `withPlatformScope()` must be
-- changed to open a transaction and pin it, exactly as `withTenant()` pins
-- the tenant id — three lines, in a file this phase does not own. It is
-- INTEGRATION step 1 in docs/PHASE-17-18-NOTES.md, with the exact diff. Until
-- it lands, the console reads nothing and the policies below are inert.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_platform_scope()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$$;

-- ---- tenants: read AND write (suspension flips one column) ---------------
--
-- The only tenant-scoped table the console may WRITE, and it may write
-- exactly one thing that matters: `status`. There is no policy anywhere that
-- lets the platform connection delete a tenant.
DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING      (id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (id = app_current_tenant_id() OR app_platform_scope());

-- ---- users: READ ONLY for the platform ------------------------------------
--
-- Support must be able to answer "which workspace is this person in?" and
-- "who here is an admin?". Support must never be able to edit a customer's
-- user record — that is role and status, which outlive any session. So the
-- platform clause is on USING and NOT on WITH CHECK.
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- billing: READ ONLY for the platform ----------------------------------
--
-- The console shows plan, status and invoice state. It does not change them:
-- a plan change is a purchase decision and a support engineer making one is
-- indistinguishable from fraud. Same asymmetry — USING only.
DO $$
DECLARE
  readable text;
BEGIN
  FOREACH readable IN ARRAY ARRAY['subscriptions', 'invoices', 'documents']
  LOOP
    IF to_regclass('public.' || readable) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
                     readable || '_tenant_isolation', readable);
      EXECUTE format(
        'CREATE POLICY %I ON %I '
        'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
        'WITH CHECK (tenant_id = app_current_tenant_id())',
        readable || '_tenant_isolation', readable);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- ⭐ WHAT IS DELIBERATELY ABSENT FROM THE LIST ABOVE
-- ---------------------------------------------------------------------------
-- contacts, companies, deals, custom_object_records, assets, contracts,
-- contract_versions, journal_entries, transactions, ledgers.
--
-- These hold data about the customer's OWN customers — third parties who
-- never had a relationship with us and whose data we hold as a PROCESSOR.
-- Reading it for our own convenience is processing with no lawful basis;
-- "it made the ticket faster" is not a purpose.
--
-- If a future phase adds a platform clause to any of them, that is a change
-- to the data-protection posture of the product and it belongs in a review,
-- not in a bug fix. Check 14 in Section 9 fails loudly if it happens.
-- ---------------------------------------------------------------------------


-- ############################################################################
-- SECTION 7 — INTEGRITY CONSTRAINTS
-- ############################################################################
--
-- The application validates all of these with Zod and produces a good error
-- message. These are the versions that are actually true.

DO $$
BEGIN
  -- A justification is the whole value of the record. "fix" is not one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_justification_length'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_justification_length
      CHECK (length(btrim(justification)) >= 20);
  END IF;

  -- A session that expires before it starts is either a clock problem or an
  -- attempt to create a record of access that "never happened".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_expiry_after_start'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_expiry_after_start
      CHECK (expires_at > started_at);
  END IF;

  -- ⭐ THE HARD CEILING ON SESSION LENGTH, IN THE DATABASE.
  -- `lib/platform/impersonation-policy.ts` caps it at 60 minutes. If that
  -- constant is ever raised without this being reviewed, the INSERT fails
  -- rather than quietly granting somebody a nine-hour session.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_max_duration'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_max_duration
      CHECK (expires_at <= started_at + interval '60 minutes');
  END IF;

  -- ⭐ BREAK-GLASS IS READ-ONLY, ENFORCED BY THE ENGINE.
  -- This is the load-bearing rule of the whole consent model: access
  -- obtained WITHOUT the customer's agreement may look and may not touch.
  -- A bug in `resolveScope()` cannot widen it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'breakglass_is_read_only'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT breakglass_is_read_only
      CHECK (mode <> 'break_glass' OR scope = 'read_only');
  END IF;

  -- A consented session must point at the consent it leans on. A session
  -- claiming consent with no consent row is unverifiable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consented_session_has_consent'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT consented_session_has_consent
      CHECK (mode = 'break_glass' OR consent_id IS NOT NULL);
  END IF;

  -- Consent always expires. A grant with no end date is how a checkbox
  -- ticked in 2024 becomes permanent access in 2027.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consent_expires_after_grant'
  ) THEN
    ALTER TABLE tenant_support_consents
      ADD CONSTRAINT consent_expires_after_grant
      CHECK (expires_at > granted_at);
  END IF;

  -- Every flag carries a written reason.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_flag_reason_present'
  ) THEN
    ALTER TABLE platform_tenant_flags
      ADD CONSTRAINT tenant_flag_reason_present
      CHECK (length(btrim(reason)) >= 10);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 8 — GRANTS
-- ############################################################################
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ADDS privileges is worthless as a restriction. If
-- anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO ordence_app`
-- — the first thing most people do when a query fails with "permission
-- denied", and something several hosting guides recommend outright — then the
-- application role already holds DELETE on the impersonation evidence, and
-- every GRANT below is a no-op that changes nothing.
--
-- The restriction is only real if it is stated as a restriction.
--
-- The privilege that matters most here is the one that is NOT granted:
-- DELETE on `platform_impersonation_sessions` and `platform_action_log`.
-- Both also have triggers refusing it (Sections 2 and 3) — belt and braces,
-- because a trigger dropped by `drizzle-kit push` is a silent failure and
-- these are the two tables where a silent failure means an operator can erase
-- the record of their own access.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON platform_staff                   FROM ordence_app;
    REVOKE ALL ON platform_impersonation_sessions  FROM ordence_app;
    REVOKE ALL ON tenant_support_consents          FROM ordence_app;
    REVOKE ALL ON platform_tenant_flags            FROM ordence_app;
    REVOKE ALL ON platform_action_log              FROM ordence_app;

    -- Staff grants are revoked by STATUS, never removed. The history of who
    -- held platform access has to survive the revocation.
    GRANT SELECT, INSERT, UPDATE ON platform_staff TO ordence_app;

    -- INSERT and the one-way close. No DELETE.
    GRANT SELECT, INSERT, UPDATE ON platform_impersonation_sessions TO ordence_app;

    -- The tenant grants and revokes; nothing deletes.
    GRANT SELECT, INSERT, UPDATE ON tenant_support_consents TO ordence_app;

    -- Flags are the one table here where a hard DELETE is harmless — a
    -- removed override simply means "no override", which is the default.
    -- It is still not granted: `enabled = false` is the honest record, and
    -- it keeps the reason and the author.
    GRANT SELECT, INSERT, UPDATE ON platform_tenant_flags TO ordence_app;

    -- ⭐ INSERT AND SELECT ONLY. The cross-tenant access log.
    GRANT SELECT, INSERT ON platform_action_log TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 9 — VERIFICATION
-- ############################################################################
--
-- Every check prints a row. Read them. A silent success is not the same as a
-- success, and these failures have no other symptom.

-- Check 1 — RLS is enabled AND forced on all five platform tables.
SELECT
  c.relname                                  AS table_name,
  c.relrowsecurity                           AS rls_enabled,
  c.relforcerowsecurity                      AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS' ELSE '*** FAIL ***' END   AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('platform_staff','platform_impersonation_sessions',
                    'tenant_support_consents','platform_tenant_flags',
                    'platform_action_log')
ORDER BY c.relname;


-- Check 2 — every policy carries a WITH CHECK clause.
--
-- A policy with only USING filters what you can READ while permitting an
-- INSERT of a row you should not be able to create. On these tables that
-- would mean a tenant session writing its own consent, or its own flags.
SELECT
  tablename,
  policyname,
  CASE WHEN with_check IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — reads filtered, writes are not ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('platform_staff','platform_impersonation_sessions',
                    'tenant_support_consents','platform_tenant_flags',
                    'platform_action_log')
ORDER BY tablename;


-- Check 3 — ⭐ THE CONSENT POLICY IS ASYMMETRIC IN THE RIGHT DIRECTION.
--
-- This is the most important row in this file. The platform-scoped
-- connection must be able to READ consent and must NOT be able to WRITE it.
-- If this ever reads FAIL, "the customer consented" becomes a claim we can
-- manufacture, and the entire consent model is decorative.
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'tenant_support_consents'
        AND with_check LIKE '%app_current_tenant_id()%'
        AND with_check NOT LIKE '%IS NULL%'
    )
    THEN 'PASS: consent can only be written by the customer''s own session'
    ELSE '*** FAIL: the platform connection can manufacture consent ***'
  END AS verdict;


-- Check 4 — the impersonation tamper triggers exist and are enabled.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       -- `tgenabled` is PostgreSQL's internal "char" type, not text. Without
       -- the cast this fails with `operator is not unique: unknown || "char"`.
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'platform_impersonation_sessions'::regclass
  AND NOT tgisinternal
ORDER BY tgname;


-- Check 5 — the append-only triggers exist on the cross-tenant access log.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'platform_action_log'::regclass
  AND NOT tgisinternal
ORDER BY tgname;


-- Check 6 — the application role holds NO DELETE on either evidence table.
SELECT
  t.tbl AS table_name,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', t.tbl, 'DELETE')
      THEN '*** FAIL: the application role can DELETE its own access evidence ***'
    ELSE 'PASS: evidence cannot be deleted by the application role'
  END AS verdict
FROM (VALUES ('platform_impersonation_sessions'), ('platform_action_log')) AS t(tbl);


-- Check 7 — the six integrity constraints exist.
SELECT
  expected.conname,
  CASE WHEN c.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — constraint is missing ***' END AS verdict
FROM (VALUES
  ('impersonation_justification_length'),
  ('impersonation_expiry_after_start'),
  ('impersonation_max_duration'),
  ('breakglass_is_read_only'),
  ('consented_session_has_consent'),
  ('consent_expires_after_grant')
) AS expected(conname)
LEFT JOIN pg_constraint c ON c.conname = expected.conname
ORDER BY expected.conname;


-- Check 8 — ⭐ NO BREAK-GLASS SESSION HAS EVER BEEN READ-WRITE.
--
-- The CHECK constraint makes it impossible going forward. This looks
-- backwards, because a constraint added AFTER data existed would not have
-- validated the rows already there.
SELECT
  id, tenant_slug, actor_email, started_at,
  '*** FAIL — a break-glass session had write access ***' AS verdict
FROM platform_impersonation_sessions
WHERE mode = 'break_glass' AND scope <> 'read_only';
-- (No rows returned = PASS.)


-- Check 9 — no session has ever outlived the one-hour ceiling.
SELECT
  id, actor_email, started_at, expires_at,
  '*** FAIL — session longer than the 60-minute ceiling ***' AS verdict
FROM platform_impersonation_sessions
WHERE expires_at > started_at + interval '60 minutes';
-- (No rows returned = PASS.)


-- Check 10 — the DELETE guard is installed on the customer-data tables.
SELECT
  count(*) FILTER (WHERE tgname = 'no_delete_under_impersonation') AS guarded_tables,
  CASE WHEN count(*) FILTER (WHERE tgname = 'no_delete_under_impersonation') >= 10
       THEN 'PASS: the impersonation delete guard is installed'
       ELSE '*** FAIL: fewer tables guarded than expected — check Section 5 ***'
  END AS verdict
FROM pg_trigger
WHERE NOT tgisinternal;


-- Check 11 — the impersonation context accessor behaves fail-closed.
--
-- Unset must read NULL, not error and not a default. A guard whose accessor
-- throws on an unset setting would break every DELETE in the product.
SELECT
  CASE WHEN app_current_impersonation_id() IS NULL
       THEN 'PASS: no impersonation context reads as NULL (guard inert)'
       ELSE '*** FAIL: an impersonation context is set in a fresh session ***'
  END AS verdict;


-- Check 12 — orphan check: live sessions whose consent has been revoked.
--
-- Not a failure of a control — consent can legitimately be withdrawn while a
-- session is running, and the session then expires on its own within the
-- hour (see the note in server/platform/consent.ts). It is listed because it
-- is the one state worth a human glancing at.
SELECT
  s.id, s.tenant_slug, s.actor_email, s.expires_at,
  'NOTICE — consent withdrawn while this session is still running' AS verdict
FROM platform_impersonation_sessions s
JOIN tenant_support_consents c ON c.id = s.consent_id
WHERE s.ended_at IS NULL
  AND s.expires_at > now()
  AND c.revoked_at IS NOT NULL;
-- (No rows returned = nothing to look at.)


-- Check 13 — the platform read scope is INERT unless deliberately requested.
--
-- If this ever reads FAIL, some connection is starting with the marker
-- already set, and "no context means zero rows" has become "no context means
-- every customer".
SELECT
  CASE WHEN app_platform_scope() = false
       THEN 'PASS: platform scope is off by default (fail-closed)'
       ELSE '*** FAIL: platform scope is ON in a fresh session ***'
  END AS verdict;


-- Check 14 — ⭐⭐ THE DATA-PROTECTION LINE, ASSERTED.
--
-- The single most important check in this file after Check 3.
--
-- Customer CONTENT tables must have NO platform clause in their policy. If
-- one appears, a platform operator can read a customer's contact list, and
-- that is a change to what this product promises — not a bug fix. It should
-- fail this check loudly and go to a review.
SELECT
  p.tablename,
  CASE WHEN p.qual LIKE '%app_platform_scope%'
       THEN '*** FAIL — platform staff can now read CUSTOMER CONTENT here ***'
       ELSE 'PASS: customer content is unreachable from the platform scope'
  END AS verdict
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('contacts','companies','deals','custom_object_records',
                      'assets','contracts','contract_versions',
                      'journal_entries','transactions','ledgers')
ORDER BY p.tablename;


-- Check 15 — the relationship tables DO carry the platform clause, and are
-- read-only from it.
--
-- `users`, `subscriptions`, `invoices` and `documents` must be readable by
-- the console (support cannot function otherwise) and must NOT be writable by
-- it — a support engineer editing a customer's user role or subscription is
-- the exact thing the impersonation deny-list forbids, and this is the
-- database's copy of that rule.
SELECT
  p.tablename,
  CASE
    WHEN p.qual NOT LIKE '%app_platform_scope%'
      THEN '*** FAIL — the console cannot read this; it will show an empty page ***'
    WHEN p.tablename <> 'tenants' AND p.with_check LIKE '%app_platform_scope%'
      THEN '*** FAIL — the console can WRITE this table ***'
    ELSE 'PASS'
  END AS verdict
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('tenants','users','subscriptions','invoices','documents')
ORDER BY p.tablename;
