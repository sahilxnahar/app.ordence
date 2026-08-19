-- ############################################################################
-- 0127 — THE COLLECTIONS LADDER CAN NEVER RECORD WHETHER A NOTICE WAS SENT
--        (Infra wave 13 / v1.80.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- `credit_dunning_log.delivery` is `NOT NULL DEFAULT 'queued'`, and the
-- application role holds no UPDATE on the table, so every row stays 'queued'
-- forever. The collections screen shows a ladder of notices that were all
-- apparently never sent, and the two CHECK constraints written to police the
-- answer are trivially satisfied because the answer is never written:
--
--     CHECK (delivery <> 'sent'   OR sent_at IS NOT NULL)
--     CHECK (delivery <> 'failed' OR failure_reason IS NOT NULL)
--
-- The writer that cannot run is `server/email/outbox.ts`, which sets exactly
-- three columns after the dispatcher gets an answer from the provider:
-- `delivery`, `sent_at`, `failure_reason`.
--
-- HOW IT HAPPENED
-- ---------------
-- 0083_credit_control_and_dunning.sql line 876:
--
--     GRANT SELECT, INSERT, UPDATE ON credit_dunning_log TO ordence_app;
--
-- and stated the design at line 778: "`delivery`, `sent_at`, `failure_reason`
-- and `next_action_on` STAY MUTABLE, because something else delivers these and
-- has to be able to write the answer back."
--
-- 0087_hardening_narrow_grants.sql lines 178 and 191:
--
--     REVOKE ALL ON credit_dunning_log     FROM ordence_app;
--     GRANT SELECT, INSERT ON credit_dunning_log TO ordence_app;
--
-- 🔴 THE SAME FILE, AND THE SAME KIND OF MISTAKE, AS THE
-- `prune_security_events` GRANT THAT 0121 REVOKED , but in the opposite
-- direction. 0087 swept a module into a REVOKE-then-narrow block and gave it
-- the default shape (SELECT, INSERT on evidence tables) without reading the
-- paragraph in 0083 that says this one table is different. One file, two
-- defects, mirror images: one privilege that should never have been granted,
-- and one that should never have been taken away.
--
-- ⚠️ WHY NOTHING CAUGHT IT. It is LATENT rather than live: production still
-- connects as `neondb_owner`, which is the table owner and is not subject to
-- these grants. The moment the role switch to `ordence_app` happens , which
-- CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql exists to prepare , collections
-- delivery status stops being recorded, silently.
--
-- ⚠️ AND THE TEST DATABASE ALREADY RUNS IN THE BROKEN POSTURE. The security
-- suite connects as `ordence_app`. It did not notice, because
-- `tests/ui/email-outbox.test.ts` is a source-grep suite: it asserts the
-- dispatcher's SOURCE CODE contains the string "creditDunningLog" and never
-- executes a statement.
--
-- WHAT THIS FILE DOES
-- -------------------
-- Restores UPDATE, but COLUMN-LEVEL and only on the four columns 0083 named:
--
--     GRANT UPDATE (delivery, sent_at, failure_reason, next_action_on)
--
-- ⭐ NOT `GRANT UPDATE ON credit_dunning_log`. The rest of the row , who was
-- written to, at what address, for how much, under which ladder , is the
-- record of a demand for money. It must be as immutable after the fact as any
-- other notice in this product. A column-level grant says that in the schema
-- rather than in a comment, which is the whole lesson of 0121.
--
-- IS THERE DATA LOSS?  No. Privileges only.
--
-- RUN ORDER
-- ---------
-- After 0087. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- Unchanged. `credit_dunning_log` keeps the tenant-isolation policy 0083 gave
-- it; this file changes only which columns the application role may write.
-- ############################################################################

DO $$
BEGIN
  IF to_regclass('public.credit_dunning_log') IS NULL THEN
    RAISE NOTICE '0127: credit_dunning_log is not present. Nothing to grant.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RAISE NOTICE '0127: role ordence_app does not exist here. Nothing to grant.';
    RETURN;
  END IF;

  -- Belt and braces: remove any table-wide UPDATE that a blanket grant may
  -- have left, so the column list below is the whole of what is held.
  REVOKE UPDATE ON credit_dunning_log FROM ordence_app;

  GRANT UPDATE (delivery, sent_at, failure_reason, next_action_on)
    ON credit_dunning_log TO ordence_app;

  RAISE NOTICE
    '0127: ordence_app may now write the delivery answer back to '
    'credit_dunning_log, and nothing else on the row.';
END
$$;


-- ----------------------------------------------------------------------------
-- VERIFY , BOTH HALVES. THE GRANT MUST EXIST AND MUST BE NARROW.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  granted   text[];
  table_wide boolean;
BEGIN
  IF to_regclass('public.credit_dunning_log') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RETURN;
  END IF;

  SELECT coalesce(array_agg(column_name ORDER BY column_name), ARRAY[]::text[])
    INTO granted
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name   = 'credit_dunning_log'
     AND grantee      = 'ordence_app'
     AND privilege_type = 'UPDATE';

  IF NOT (granted @> ARRAY['delivery','failure_reason','next_action_on','sent_at']) THEN
    RAISE EXCEPTION
      '0127 FAILED: ordence_app cannot write the delivery answer back. It '
      'holds UPDATE on: %. Every dunning notice will stay "queued" forever '
      'and the collections screen will report that nothing was ever sent.',
      coalesce(array_to_string(granted, ', '), '(nothing)')
      USING ERRCODE = '42501';
  END IF;

  SELECT has_table_privilege('ordence_app', 'credit_dunning_log', 'UPDATE')
     AND cardinality(granted) > 4
    INTO table_wide;

  IF table_wide THEN
    RAISE EXCEPTION
      '0127 FAILED: ordence_app holds UPDATE on more than the four delivery '
      'columns (%). The rest of the row is the record of a demand for money '
      'and must stay immutable after the fact.',
      array_to_string(granted, ', ')
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE
    '0127 PASS: UPDATE is held on exactly the four delivery columns.';
END
$$;
