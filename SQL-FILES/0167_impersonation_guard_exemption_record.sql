-- ═══════════════════════════════════════════════════════════════════════
-- Ordence — Track D, wave 17
-- THE TWELVE TABLES WITHOUT `no_delete_under_impersonation`, RECORDED
-- ═══════════════════════════════════════════════════════════════════════
--
-- 🔴 NO NUMBER, ON PURPOSE. Track D holds none. Integration: rename to the
--    next free number. (Wave 15's file was numbered 0166 the same way.)
--
-- ⚠️ THIS MIGRATION CHANGES NO DATA AND NO BEHAVIOUR. It writes twelve
--    `COMMENT ON TABLE`s and then refuses to apply if the coverage it
--    describes is no longer true. That is the whole point: integration
--    asked for the wave-15 decision to be recorded "in a migration comment
--    or a doc, not only in a report", and a comment that can go stale
--    silently is the thing this repository keeps being bitten by.
--
-- ⭐ THE COMMENTS ARE THE RECORD AND THE `DO` BLOCK IS THE TEETH.
--    `\d+ change_log` in a console now answers "why has this no guard?"
--    without anyone opening a report, and the block below means the answer
--    cannot outlive the fact.
--
-- ⚠️ THE SAME CHECK RUNS IN CI WITHOUT THIS FILE:
--    `tests/security/impersonation-guard-exemptions.test.ts`. The migration
--    is for the database's own copy of the decision; the test is what fails
--    a build. Neither is redundant — a schema restored from backup has the
--    comments, and a branch that never applies migrations still has the test.
--
-- ═══════════════════════════════════════════════════════════════════════
-- MEASURED ON THE ASSEMBLED WAVE-17 TREE
-- ═══════════════════════════════════════════════════════════════════════
--   306 base tables carry `tenant_id`   (up from 303 at 1.81.0-alpha)
--   294 carry `no_delete_under_impersonation`
--    12 do not — and they are the SAME twelve as at 1.81.0-alpha.
--
-- The three tenant tables that arrived from other tracks all received the
-- guard automatically from 0125's `attach_impersonation_guards()`, which is
-- the mechanism working.
--
-- ═══════════════════════════════════════════════════════════════════════
-- 🔴 ELEVEN OF THE TWELVE ARE DELIBERATE. ONE IS NOT.
-- ═══════════════════════════════════════════════════════════════════════
-- `change_log` carries NO trigger at all:
--
--     SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--      WHERE NOT t.tgisinternal AND c.relname = 'change_log';   -- (0 rows)
--
-- Its four evidence siblings each have a `*_no_delete` ROW trigger. What
-- stops a delete on `change_log` is a REVOKE — and a REVOKE does not bind
-- `neondb_owner`, which is what production connects as. So the field-level
-- history behind the audit trail is deletable in production, including by
-- staff inside a customer's workspace under impersonation.
--
-- ⚠️ THE REMEDY IS `no_delete_under_impersonation`, NOT AN APPEND-ONLY
-- TRIGGER. An append-only trigger would make `change_log` rows undeletable
-- by anyone — and that is exactly what already makes a tenant with
-- `security_events` rows impossible to delete (wave 15 §4.2), which the
-- DPDPA erasure work has to solve rather than inherit twice. The narrow
-- guard refuses the impersonated delete and leaves lawful erasure possible.
-- The one-line migration is in `PATCH-REQUEST-D.md`; it is NOT applied here
-- because it changes behaviour and this file deliberately does not.
-- ═══════════════════════════════════════════════════════════════════════


/* ---- ① EVIDENCE: protected by something stricter ------------------- */

COMMENT ON TABLE audit_logs IS
  'Append-only evidence. No `no_delete_under_impersonation` guard BY DESIGN: '
  '`audit_logs_no_delete` refuses DELETE for every role, impersonating or not, '
  'so the impersonation guard would be a strictly weaker lock on a bolted door. '
  'Track D wave 17.';

COMMENT ON TABLE change_log IS
  '🔴 EXEMPT AND SHOULD NOT BE. Field-level history behind the audit trail. It '
  'has NO trigger of any kind — unlike its four evidence siblings — and the only '
  'thing refusing a DELETE is a REVOKE from ordence_app, which does not bind the '
  'table owner that production connects as. Needs `no_delete_under_impersonation`. '
  'Track D wave 17, verdict: needs_action.';

COMMENT ON TABLE error_events IS
  'Append-only diagnostics about our own failures, not the customer''s records. '
  'No impersonation guard BY DESIGN: `error_events_no_delete` already refuses '
  'DELETE for every role. Track D wave 17.';

COMMENT ON TABLE permission_denials IS
  'Append-only evidence of refused permission checks — the clearest early signal '
  'of an account being misused. No impersonation guard BY DESIGN: '
  '`permission_denials_no_delete` refuses DELETE for every role. Track D wave 17.';

COMMENT ON TABLE security_events IS
  'Append-only SecOps stream. No impersonation guard BY DESIGN: '
  '`prevent_security_event_delete` refuses DELETE for EVERY role including the '
  'table owner, and retention runs through prune_security_events(). '
  '⚠️ The ON DELETE SET NULL on tenant_id cannot fire either, which makes a '
  'tenant with any row here undeletable — see Track D wave 15 §4.2. Track D wave 17.';

/* ---- ② PLATFORM-OWNED: the rows are ours, not the tenant''s --------- */

COMMENT ON TABLE platform_impersonation_sessions IS
  'The record OF an impersonation. No impersonation guard BY DESIGN and it could '
  'not have one: a trigger keyed on app.impersonation_id would stop the session '
  'row being closed by the session that opened it. Track D wave 17.';

COMMENT ON TABLE platform_tenant_flags IS
  'Feature overrides Ordence sets for one workspace, written by platform staff '
  'through the console and never by the tenant. No impersonation guard BY DESIGN: '
  'a tenant-facing delete guard would protect a customer from a row they cannot '
  'see or set. Gated by the `flags:write` capability. Track D wave 17.';

COMMENT ON TABLE tenant_health_events IS
  'Ordence''s own churn and health signals ABOUT an account. The customer is the '
  'subject, not the author. No impersonation guard BY DESIGN. Track D wave 17.';

COMMENT ON TABLE tenant_support_consents IS
  'The customer''s grant of support access — the thing that authorises '
  'impersonation in the first place. No impersonation guard BY DESIGN; consent is '
  'withdrawn, not deleted, and the withdrawal is the record. Track D wave 17.';

/* ---- ③ METERING: derived and regenerable --------------------------- */

COMMENT ON TABLE usage_counters IS
  'Derived counters recomputed from source events. No impersonation guard BY '
  'DESIGN: deleting one loses a number the next sweep regenerates. Track D wave 17.';

COMMENT ON TABLE usage_levels IS
  'The tier a usage counter resolves to. Derived; same argument as usage_counters. '
  'No impersonation guard BY DESIGN. Track D wave 17.';

COMMENT ON TABLE web_vital_events IS
  'Browser performance samples, aggregate and continuously regenerated by traffic. '
  'No impersonation guard BY DESIGN. Track D wave 17.';


-- ═══════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION — the record cannot outlive the fact
-- ═══════════════════════════════════════════════════════════════════════
--
-- ⚠️ IT RAISES IN BOTH DIRECTIONS. A THIRTEENTH unguarded table means a new
-- table missed `attach_impersonation_guards()`; a table that GAINS the
-- guard while still commented "BY DESIGN" means the comment is now a lie.
-- Both are worth stopping a migration for, and neither is worth discovering
-- in wave 19.
DO $$
DECLARE
  recorded text[] := ARRAY[
    'audit_logs',
    'change_log',
    'error_events',
    'permission_denials',
    'platform_impersonation_sessions',
    'platform_tenant_flags',
    'security_events',
    'tenant_health_events',
    'tenant_support_consents',
    'usage_counters',
    'usage_levels',
    'web_vital_events'
  ];
  live      text[];
  appeared  text[];
  vanished  text[];
BEGIN
  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[])
    INTO live
    FROM (
      SELECT c.table_name AS t
        FROM information_schema.columns c
        JOIN pg_class k
          ON k.relname = c.table_name
         AND k.relnamespace = 'public'::regnamespace
       WHERE c.table_schema = 'public'
         AND c.column_name = 'tenant_id'
         AND k.relkind = 'r'
         AND NOT EXISTS (
           SELECT 1 FROM pg_trigger tg
            WHERE tg.tgrelid = k.oid
              AND tg.tgname = 'no_delete_under_impersonation'
         )
    ) s;

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO appeared
    FROM unnest(live) AS x WHERE NOT (x = ANY(recorded));

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO vanished
    FROM unnest(recorded) AS x WHERE NOT (x = ANY(live));

  IF array_length(appeared, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant table(s) newly WITHOUT the impersonation delete guard: %. '
      'Either attach_impersonation_guards() was not run for them, or somebody '
      'has taken a decision that is not recorded. Do not add them to the list '
      'above to make this pass.',
      array_to_string(appeared, ', ');
  END IF;

  IF array_length(vanished, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Table(s) recorded as deliberately exempt now HAVE the guard: %. '
      'The COMMENT ON TABLE above now says "BY DESIGN" about a table that is '
      'guarded — delete the entry rather than leaving a stale exemption.',
      array_to_string(vanished, ', ');
  END IF;

  RAISE NOTICE
    'Track D: impersonation guard exemptions verified — % recorded, % live, and they match.',
    array_length(recorded, 1), array_length(live, 1);
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- SECOND CHECK: the four evidence siblings really do refuse a DELETE
-- ═══════════════════════════════════════════════════════════════════════
--
-- 🔴 THE FIRST BLOCK PROVES THE EXEMPT SET IS THE RECORDED SET. It does not
-- prove the REASONS are true. Four of the twelve are exempted on the
-- grounds that "something stricter already refuses a DELETE" — and one more,
-- `change_log`, was exempted on the same grounds in wave 15 and turned out
-- to have nothing. This asks the catalogue rather than trusting the comment.
DO $$
DECLARE
  guarded_by_trigger text[] := ARRAY[
    'audit_logs', 'error_events', 'permission_denials', 'security_events'
  ];
  missing text[];
BEGIN
  SELECT coalesce(array_agg(t), ARRAY[]::text[])
    INTO missing
    FROM unnest(guarded_by_trigger) AS t
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relname = t
        AND c.relnamespace = 'public'::regnamespace
        AND NOT tg.tgisinternal
        AND (tg.tgtype::int & 8) = 8            -- fires on DELETE
   );

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Table(s) exempted from the impersonation guard because an append-only '
      'trigger protects them have NO DELETE trigger: %. The exemption rests on '
      'a control that does not exist — which is exactly how change_log got here.',
      array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE
    'Track D: all four trigger-protected exemptions verified against pg_trigger.';
END $$;
