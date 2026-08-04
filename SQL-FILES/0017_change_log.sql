-- ============================================================================
-- Ordence — The Change Log
-- Version: v0.23.0-alpha
--
-- Applies to BOTH builds. Run after ALL-IN-ONE-SETUP.sql.
--
-- ============================================================================
-- ⚠️  WHY THIS EXISTS NOW, WHEN SYNC IS NOT BEING BUILT
-- ============================================================================
-- You asked for a fully offline application, with online kept open as a
-- later choice. That is a sound sequence — but it has exactly two
-- decisions that must be made correctly TODAY, because they cannot be
-- retrofitted afterwards at any price:
--
--   1. IDENTIFIERS MUST BE GENERATED LOCALLY, NOT FROM A SEQUENCE.
--      Two laptops both numbering leads 1, 2, 3 cannot be merged. Not
--      "with difficulty" — the question of which "lead 3" is which has
--      no answer. Our schema already uses gen_random_uuid() throughout,
--      so this one is already satisfied and simply has to stay true.
--
--   2. EVERY CHANGE MUST BE RECORDED AS IT HAPPENS.  ← this file
--
-- The second is the one people skip, and it is the one that hurts.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY `updated_at` IS NOT ENOUGH — THE POINT OF THE WHOLE FILE
-- ══════════════════════════════════════════════════════════════════════
-- The obvious plan is "sync everything where updated_at > last sync".
-- It is obvious, it is what everybody tries first, and it loses data in
-- three specific ways:
--
--   • DELETIONS ARE INVISIBLE. A row deleted on the laptop simply is not
--     in the result set. The server never learns it went, and the next
--     sync helpfully restores it. The user deletes it again. Forever.
--
--   • THE LAST WRITER SILENTLY WINS. Two people edit one booking's
--     agreement value offline. `updated_at` tells you which was saved
--     later. It does not tell you they conflicted, so nobody is ever
--     asked, and one number is quietly gone.
--
--   • YOU CANNOT SEE WHAT CHANGED. Knowing a row changed is not knowing
--     which FIELD changed. Two people editing different fields of one
--     lead is not a conflict at all — but without the before-and-after
--     you cannot tell it apart from one that is.
--
-- A change log fixes all three, and it must be written AT THE MOMENT OF
-- THE CHANGE. History you did not record is not recoverable later. That
-- is the entire argument for doing this before sync rather than with it.
--
-- ⚠️ THIS FILE BUILDS NO SYNC. Nothing here talks to a network, and
-- nothing reads this table yet. It is a recorder, and it costs one small
-- INSERT per write.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — THE LOG
-- ############################################################################

CREATE TABLE IF NOT EXISTS change_log (
  -- ⚠️ A bigserial, and this is the ONE place a sequence is correct.
  -- It orders events on THIS machine only and is never compared across
  -- machines. Everything that crosses a boundary is a uuid.
  seq           bigserial PRIMARY KEY,

  tenant_id     uuid        NOT NULL,
  table_name    text        NOT NULL,
  row_id        uuid        NOT NULL,
  operation     text        NOT NULL CHECK (operation IN ('insert','update','delete')),

  -- The full row before and after. Deliberately generous: a diff is
  -- cheap to compute later from these, and impossible to compute from a
  -- diff you did not keep.
  old_row       jsonb,
  new_row       jsonb,

  -- Which columns actually changed. Precomputed because the conflict
  -- question — "did we touch the SAME field?" — is asked far more often
  -- than the rows are read.
  changed_cols  text[],

  -- ⚠️ THE ORIGIN. Which installation made this change.
  --
  -- Without it, a synced-down change is indistinguishable from a local
  -- one, so the next sync sends it straight back where it came from and
  -- two machines ping-pong the same edit forever. Every sync system that
  -- omits this rediscovers it in week one.
  origin_id     uuid        NOT NULL,

  actor_id      uuid,
  changed_at    timestamptz NOT NULL DEFAULT now(),

  -- Null until sync exists. When it does, this is what "already sent"
  -- means, and it is why the log can be pruned safely.
  synced_at     timestamptz
);

CREATE INDEX IF NOT EXISTS change_log_unsynced_idx
  ON change_log (tenant_id, seq) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS change_log_row_idx
  ON change_log (table_name, row_id, seq DESC);


-- ############################################################################
-- SECTION 2 — THIS INSTALLATION'S IDENTITY
-- ############################################################################
--
-- One row, created once, never changed. Copying the database file to a
-- second machine copies this id too — which is a real hazard, because
-- two installations claiming one origin is precisely the ping-pong above.
-- Detecting that is a sync-time problem; recording the id is not, and
-- has to happen now.

CREATE TABLE IF NOT EXISTS installation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installed_at  timestamptz NOT NULL DEFAULT now(),
  singleton     boolean NOT NULL DEFAULT true,
  CONSTRAINT installation_is_singleton UNIQUE (singleton)
);

INSERT INTO installation (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app_origin_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM installation LIMIT 1;
$$;


-- ############################################################################
-- SECTION 3 — THE RECORDER
-- ############################################################################
--
-- ⚠️ A TRIGGER, NOT APPLICATION CODE, AND THE REASON MATTERS.
--
-- Recording changes in the server actions would cover the server
-- actions. It would miss an import script, a support fix, a future API
-- route, and a bulk UPDATE — which are exactly the writes that produce
-- the largest and most confusing divergence.
--
-- A log with holes in it is arguably worse than no log, because it looks
-- complete. Attaching it to the table means there is no write path that
-- escapes it.

CREATE OR REPLACE FUNCTION record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old      jsonb;
  v_new      jsonb;
  v_row_id   uuid;
  v_tenant   uuid;
  v_changed  text[];
  v_actor    uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL;
    v_new := to_jsonb(NEW);
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  END IF;

  v_row_id := COALESCE((v_new->>'id')::uuid, (v_old->>'id')::uuid);
  v_tenant := COALESCE((v_new->>'tenant_id')::uuid, (v_old->>'tenant_id')::uuid);

  -- A row with no tenant is platform catalogue data (plans, permissions).
  -- It is not per-customer state and has no business in a per-customer
  -- change feed.
  IF v_tenant IS NULL OR v_row_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO v_changed
      FROM jsonb_each(v_new)
     WHERE v_old -> key IS DISTINCT FROM v_new -> key
       -- ⚠️ `updated_at` changes on literally every update, so including
       -- it would mark every row as conflicting with every other edit and
       -- make the changed-columns list useless for its one purpose.
       AND key <> 'updated_at';

    -- Nothing of substance changed. Recording it would fill the log with
    -- noise and make "what happened to this record?" unanswerable.
    IF v_changed IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Best-effort. The actor is set by the app; a script may not set one,
  -- and an unattributed change is still worth recording.
  BEGIN
    v_actor := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  INSERT INTO change_log
    (tenant_id, table_name, row_id, operation, old_row, new_row,
     changed_cols, origin_id, actor_id)
  VALUES
    (v_tenant, TG_TABLE_NAME, v_row_id, lower(TG_OP), v_old, v_new,
     v_changed, app_origin_id(), v_actor);

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ############################################################################
-- SECTION 4 — ATTACHING IT
-- ############################################################################
--
-- ⚠️ EVERY TENANT-SCOPED TABLE, DISCOVERED RATHER THAN LISTED.
--
-- A hand-written list is a list somebody forgets to extend, and the
-- omission is silent — the table simply never syncs, and nobody finds
-- out until data goes missing between two machines.
--
-- So the set is computed: every table in `public` with a `tenant_id`
-- column, minus the exclusions below. A new table in a future phase is
-- covered the moment this file is re-run, which the deploy procedure
-- already requires after any schema change.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND t.table_type   = 'BASE TABLE'
       AND c.table_name NOT IN (
         -- The log must not log itself. Infinite recursion, immediately.
         'change_log',
         -- ⚠️ Append-only evidence, EXCLUDED DELIBERATELY.
         --
         -- These tables already cannot be updated or deleted, so their
         -- history is the table. Logging them would double the storage
         -- for the fastest-growing tables in the system and record
         -- nothing that is not already immutable.
         'audit_logs', 'payment_events', 'security_events',
         'error_events', 'web_vital_events', 'permission_denials',
         'lead_activities', 'contract_signatures',
         -- Counters, not content. They move constantly and are derived.
         'usage_counters', 'usage_levels',
         -- ⚠️ PLATFORM ADMINISTRATION, EXCLUDED FOR A REASON THIS FILE
         -- DISCOVERED THE HARD WAY.
         --
         -- These carry a tenant_id, so the automatic discovery above
         -- picked them up. But they are WRITTEN BY PLATFORM STAFF
         -- OUTSIDE ANY TENANT CONTEXT — `withPlatformScope()`, where
         -- app_current_tenant_id() is NULL by design.
         --
         -- The change_log's own WITH CHECK then refused the insert, and
         -- because the recorder is an AFTER trigger the refusal took the
         -- whole statement with it: closing an impersonation session
         -- started failing outright. Two security tests caught it.
         --
         -- Excluding them is not a workaround. A customer's sync feed is
         -- their own records; "an Ordence engineer opened a support
         -- session" is platform activity, it already lives in
         -- `platform_action_log` as append-only evidence, and it has no
         -- business being replicated to a customer's laptop.
         'platform_impersonation_sessions', 'platform_tenant_flags',
         'tenant_support_consents', 'platform_action_log'
       )
     ORDER BY c.table_name
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_change_log', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION record_change()',
      r.table_name || '_change_log', r.table_name
    );
  END LOOP;
END
$$;


-- ############################################################################
-- SECTION 5 — GRANTS
-- ############################################################################

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON change_log   FROM ordence_app;
    REVOKE ALL ON installation FROM ordence_app;

    -- ⚠️ SELECT and INSERT only, and the INSERT is what the trigger uses.
    --
    -- No UPDATE and no DELETE: a change log the application can rewrite
    -- is not a record of what happened, it is a record of what the
    -- application currently claims happened. Pruning synced rows is an
    -- administrative operation, deliberately outside the app's reach.
    GRANT SELECT, INSERT ON change_log TO ordence_app;
    GRANT USAGE, SELECT ON SEQUENCE change_log_seq_seq TO ordence_app;
    GRANT SELECT ON installation TO ordence_app;
  END IF;
END
$$;

-- ⚠️ change_log carries a tenant_id, so it is under RLS like everything
-- else. Without this the desktop build is unaffected (one tenant) and
-- the HOSTED build would let one customer read another's entire edit
-- history — which is more revealing than the records themselves.
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS change_log_tenant_isolation ON change_log;
CREATE POLICY change_log_tenant_isolation ON change_log
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 6 — VERIFICATION
-- ############################################################################

-- Check 1 — the log is attached to every table it should be.
SELECT
  CASE WHEN missing = 0
       THEN 'PASS: every tenant-scoped table records its changes (' || attached || ' tables)'
       ELSE 'FAIL: ' || missing || ' tenant-scoped table(s) are NOT recording changes - '
            'data written there can never be synced'
  END AS check_change_log_coverage
FROM (
  SELECT
    count(*) FILTER (WHERE tg.tgname IS NOT NULL) AS attached,
    count(*) FILTER (WHERE tg.tgname IS NULL)     AS missing
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  LEFT JOIN pg_trigger tg
    ON tg.tgname = c.table_name || '_change_log' AND NOT tg.tgisinternal
 WHERE c.table_schema = 'public'
   AND c.column_name  = 'tenant_id'
   AND t.table_type   = 'BASE TABLE'
   AND c.table_name NOT IN (
     'change_log','audit_logs','payment_events','security_events',
     'error_events','web_vital_events','permission_denials',
     'lead_activities','contract_signatures','usage_counters','usage_levels',
     'platform_impersonation_sessions','platform_tenant_flags',
     'tenant_support_consents','platform_action_log'
   )
) counts;


-- Check 2 — this installation has exactly one identity.
SELECT
  CASE WHEN count(*) = 1
       THEN 'PASS: installation identity recorded'
       ELSE 'FAIL: expected exactly 1 installation row, found ' || count(*)
  END AS check_installation_identity
FROM installation;


-- Check 3 — the app cannot rewrite history.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: no ordence_app role'
    WHEN has_table_privilege('ordence_app','change_log','UPDATE')
      OR has_table_privilege('ordence_app','change_log','DELETE')
      THEN 'FAIL: the application can rewrite the change log'
    ELSE 'PASS: the change log is append-only to the application'
  END AS check_change_log_immutable;
