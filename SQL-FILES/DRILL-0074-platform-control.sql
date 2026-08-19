-- =====================================================================
--  ORDENCE — ⭐⭐⭐ THE DRILL FOR 0074
--  Version: v1.22.0-alpha
--
--  🔴🔴 RUN AS `app_user`, NEVER AS THE OWNER OR A SUPERUSER.
--  A superuser BYPASSES row level security entirely. A drill run as
--  postgres proves that postgres can read everything, which was never
--  in question, and it has passed while the policies were wrong.
--
--  ⚠️ EVERY REFUSAL IS PAIRED WITH A POSITIVE CASE. A test that only
--  checks that something failed cannot tell "the constraint worked"
--  from "the insert was broken for an unrelated reason" — a typo in a
--  column name refuses just as convincingly as a policy does.
-- =====================================================================

\set ON_ERROR_STOP off
\timing off

-- =====================================================================
--  ① THE SELF-APPROVAL WAIT
-- =====================================================================

\echo '--- ①a NEGATIVE: self-approval without the flag must be REFUSED'
INSERT INTO platform_approval_queue
  (action_kind, target_type, target_id, target_label, payload,
   requested_by, requested_at, justification, required_grade, expires_at,
   status, approver_id, decided_at)
VALUES
  ('tenant.suspend', 'tenant', NULL, 'Acme (acme)', '{}'::jsonb,
   '22222222-2222-2222-2222-222222222222', now() - interval '2 hours',
   'customer asked us to pause billing while they restructure',
   'owner', now() + interval '2 hours',
   'approved', '22222222-2222-2222-2222-222222222222', now());

\echo '--- ①b NEGATIVE: self-approval flagged but only 5 minutes old must be REFUSED'
INSERT INTO platform_approval_queue
  (action_kind, target_type, target_label, payload,
   requested_by, requested_at, justification, required_grade, expires_at,
   status, approver_id, decided_at, self_approved)
VALUES
  ('tenant.suspend', 'tenant', 'Acme (acme)', '{}'::jsonb,
   '22222222-2222-2222-2222-222222222222', now() - interval '5 minutes',
   'customer asked us to pause billing while they restructure',
   'owner', now() + interval '2 hours',
   'approved', '22222222-2222-2222-2222-222222222222', now(), true);

\echo '--- ①c POSITIVE: self-approval flagged, 20 minutes waited, must SUCCEED'
INSERT INTO platform_approval_queue
  (action_kind, target_type, target_label, payload,
   requested_by, requested_at, justification, required_grade, expires_at,
   status, approver_id, decided_at, self_approved)
VALUES
  ('tenant.suspend', 'tenant', 'Acme (acme)', '{}'::jsonb,
   '22222222-2222-2222-2222-222222222222', now() - interval '20 minutes',
   'customer asked us to pause billing while they restructure',
   'owner', now() + interval '2 hours',
   'approved', '22222222-2222-2222-2222-222222222222', now(), true);

\echo '--- ①d POSITIVE: a DIFFERENT approver needs no wait and no flag'
INSERT INTO platform_approval_queue
  (action_kind, target_type, target_label, payload,
   requested_by, requested_at, justification, required_grade, expires_at,
   status, approver_id, decided_at)
VALUES
  ('tenant.suspend', 'tenant', 'Acme (acme)', '{}'::jsonb,
   '22222222-2222-2222-2222-222222222222', now() - interval '1 minute',
   'customer asked us to pause billing while they restructure',
   'owner', now() + interval '2 hours',
   'approved', '33333333-3333-3333-3333-333333333333', now());

\echo '--- ①e NEGATIVE: a three-character justification must be REFUSED'
INSERT INTO platform_approval_queue
  (action_kind, target_type, target_label, payload, requested_by,
   justification, required_grade, expires_at)
VALUES
  ('tenant.suspend', 'tenant', 'Acme (acme)', '{}'::jsonb,
   '22222222-2222-2222-2222-222222222222',
   'fix', 'owner', now() + interval '2 hours');

-- =====================================================================
--  ② BREAK-GLASS MUST BE EXPLAINED
-- =====================================================================

\echo '--- ②a NEGATIVE: break-glass with a 19-character reason must be REFUSED'
INSERT INTO platform_impersonation_sessions
  (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
   mode, scope, justification, expires_at, break_glass_reason)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'acme',
   '22222222-2222-2222-2222-222222222222', 'user_x', 'ops@ordence.com',
   'break_glass', 'read_only',
   'invoicing has been down since 3am and nobody is answering',
   now() + interval '15 minutes',
   'urgent, cannot wait');

\echo '--- ②b POSITIVE: the same row with a real reason must SUCCEED'
INSERT INTO platform_impersonation_sessions
  (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
   mode, scope, justification, expires_at, break_glass_reason)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'acme',
   '22222222-2222-2222-2222-222222222222', 'user_x', 'ops@ordence.com',
   'break_glass', 'read_only',
   'invoicing has been down since 3am and nobody is answering',
   now() + interval '15 minutes',
   'Their invoicing has failed since 3am, nobody at the company is reachable, and their GST filing is due at nine.');

\echo '--- ②c POSITIVE: a CONSENTED session needs no break-glass reason'
INSERT INTO platform_impersonation_sessions
  (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
   mode, scope, justification, expires_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'acme',
   '22222222-2222-2222-2222-222222222222', 'user_x', 'ops@ordence.com',
   'incident_consent', 'read_write',
   'ticket 4471, they asked us to look at the failing import',
   now() + interval '60 minutes');

-- =====================================================================
--  ③ ONE OPEN HEALTH EVENT PER TENANT PER RULE
-- =====================================================================
--
--  🔴🔴 EVERY STATEMENT BELOW IS WRAPPED IN ITS OWN PLATFORM-SCOPE
--  TRANSACTION, AND THE FIRST DRAFT OF THIS DRILL WAS NOT.
--
--  ⚠️ WHAT HAPPENED IS EXACTLY THE FAILURE THE HOUSE RULE WARNS ABOUT.
--  The UPDATE that was supposed to be refused by the
--  `tenant_health_resolution_is_explained` CHECK reported `UPDATE 0` and
--  I could have written it down as a pass. It was not a pass. RLS had
--  hidden every row from a session with no scope set, so the statement
--  matched nothing and the constraint was never reached — and the
--  positive case that followed reported `UPDATE 0` in exactly the same
--  way, which is what gave it away.
--
--  ⭐ THAT IS THE ENTIRE ARGUMENT FOR PAIRING EVERY REFUSAL WITH A
--  POSITIVE. A refusal on its own cannot be told apart from a statement
--  that never ran.

\echo '--- ③a POSITIVE: the first open event must SUCCEED'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO tenant_health_events (tenant_id, rule_key, severity, headline, what_to_do)
VALUES ('11111111-1111-1111-1111-111111111111', 'dormant', 'high',
        'Acme has had no activity for 24 days.', 'Ring them this week.');
COMMIT;

\echo '--- ③b NEGATIVE: a SECOND open event for the same rule must be REFUSED'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO tenant_health_events (tenant_id, rule_key, severity, headline, what_to_do)
VALUES ('11111111-1111-1111-1111-111111111111', 'dormant', 'high',
        'Acme has had no activity for 25 days.', 'Ring them this week.');
COMMIT;

\echo '--- ③c POSITIVE: a DIFFERENT rule for the same tenant must SUCCEED'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO tenant_health_events (tenant_id, rule_key, severity, headline, what_to_do)
VALUES ('11111111-1111-1111-1111-111111111111', 'integration_dark', 'medium',
        'IndiaMART at Acme has brought nothing in for 71 hours.', 'A revoked key is the usual cause.');
COMMIT;

\echo '--- ③d NEGATIVE: resolving with a four-character note must be REFUSED'
\echo '    (a row count of 0 here would mean the statement never reached the CHECK)'
BEGIN;
SET LOCAL app.platform_scope = 'on';
UPDATE tenant_health_events
   SET resolved_at = now(), resolution_note = 'done'
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND rule_key = 'dormant'
   AND resolved_at IS NULL;
COMMIT;

\echo '--- ③e POSITIVE: resolving with a real note must SUCCEED — and must report UPDATE 1'
BEGIN;
SET LOCAL app.platform_scope = 'on';
UPDATE tenant_health_events
   SET resolved_at = now(),
       resolution_note = 'Rang the owner, they are mid-migration and back next week.'
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND rule_key = 'dormant'
   AND resolved_at IS NULL;
COMMIT;

\echo '--- ③f POSITIVE: with the first one CLOSED, the rule may open again'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO tenant_health_events (tenant_id, rule_key, severity, headline, what_to_do)
VALUES ('11111111-1111-1111-1111-111111111111', 'dormant', 'high',
        'Acme has gone quiet again.', 'Ring them again.');
COMMIT;

-- =====================================================================
--  ④ ROW LEVEL SECURITY — THE PART A SUPERUSER CANNOT TEST
-- =====================================================================

\echo '--- ④a POSITIVE: the PLATFORM scope sees the health events'
BEGIN;
SET LOCAL app.platform_scope = 'on';
SELECT count(*) AS platform_sees FROM tenant_health_events;
COMMIT;

\echo '--- ④b NEGATIVE: a TENANT session sees NOTHING, not even its own'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS tenant_sees FROM tenant_health_events;
COMMIT;

\echo '--- ④c NEGATIVE: a tenant session cannot WRITE one either'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO tenant_health_events (tenant_id, rule_key, severity, headline, what_to_do)
VALUES ('11111111-1111-1111-1111-111111111111', 'made_up', 'low', 'x', 'y');
COMMIT;

\echo '--- ④d POSITIVE: entitlement history is readable in platform scope'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO platform_entitlement_history
  (tenant_id, flag_key, before_enabled, after_enabled, changed_by, reason)
VALUES ('11111111-1111-1111-1111-111111111111', 'entitlement:inv.core',
        false, true, '22222222-2222-2222-2222-222222222222',
        'Trial extension agreed on the call');
SELECT count(*) AS platform_sees_history FROM platform_entitlement_history;
COMMIT;

\echo '--- ④e NEGATIVE: and invisible to the workspace it is about'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS tenant_sees_history FROM platform_entitlement_history;
COMMIT;

\echo '--- DRILL COMPLETE ---'
