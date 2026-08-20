-- ═══════════════════════════════════════════════════════════════════════
-- Ordence — Track D, wave 15 · DRILL
-- 🔴 A TENANT THAT HAS EVER GENERATED ONE SECURITY EVENT CANNOT BE DELETED
-- ═══════════════════════════════════════════════════════════════════════
--
-- ⛔ DO NOT RUN THIS IN NEON. IT CREATES AND DELETES ROWS IN `tenants`.
--    Run it against a throwaway local PostgreSQL 16 only. It is named the
--    way it is so that a careless paste into the Neon console is caught by
--    the reader before it is caught by the database.
--
-- ═══════════════════════════════════════════════════════════════════════
-- THE FINDING
-- ═══════════════════════════════════════════════════════════════════════
-- Two controls in this schema are individually correct and disagree with
-- each other:
--
--   ① `db/schema/secops.ts` declares
--        tenantId: uuid("tenant_id").references(() => tenants.id,
--                                               { onDelete: "set null" })
--      with the comment: *"`onDelete: cascade` is WRONG here and is
--      deliberately not used: deleting a tenant must not silently erase the
--      record of attacks mounted against it or from it. `set null` demotes
--      the row to platform-scoped and keeps it."*
--
--   ② `prevent_security_event_mutation` refuses **every** UPDATE on
--      `security_events`, for every role including the table owner —
--      because the table is evidence and evidence is append-only.
--
-- ⚠️ `ON DELETE SET NULL` IS IMPLEMENTED AS AN UPDATE. So ② refuses ①, and
-- the DELETE on `tenants` fails:
--
--     ERROR:  security_events is append-only. UPDATE is not permitted on
--             security evidence.
--     CONTEXT: SQL statement "UPDATE ONLY "public"."security_events"
--              SET "tenant_id" = NULL WHERE $1 = "tenant_id""
--
-- The demotion the schema comment describes has never been possible.
--
-- ⚠️ WHY IT HAS NOT BITTEN YET, AND WHY IT WILL. Batch 0110 established
-- that NO TENANT PURGE EXISTS in this product: one writer of
-- `tenants.deleted_at` (the Clerk webhook), nothing ever writes
-- `tenants.deleted_by`, and there is no `DELETE FROM tenants` outside
-- drills and demo seeds. So nothing has attempted this. The DPDPA erasure
-- work is the thing that will, and this is the wall it will hit.
--
-- ⚠️ AND THE WORKAROUND IS NOT "DELETE THE EVIDENCE FIRST". DELETE is
-- refused too, by `prevent_security_event_delete`. Retention is
-- `prune_security_events()`, which requires a privileged role. A purge
-- design has to route through that function or the FK has to stop being
-- `SET NULL`; either is a decision for whoever owns the purge, which is
-- not Track D.
--
-- ═══════════════════════════════════════════════════════════════════════
-- HOW TO RUN
-- ═══════════════════════════════════════════════════════════════════════
--   psql -h 127.0.0.1 -p <throwaway> -U postgres -d ordence_test \
--        -f SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-TRACK-D-tenant-delete-blocked.sql
--
-- EXPECTED OUTPUT: two NOTICEs, then a final NOTICE saying the drill
-- passed. The drill FAILS (raises) if the delete unexpectedly succeeds —
-- which would mean somebody has since removed the append-only trigger, and
-- that is a much larger finding than this one.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  probe_tenant uuid := '00000000-0000-4d00-8d00-0000000d0001';
  blocked      boolean := false;
  err          text;
BEGIN
  ---------------------------------------------------------------------
  -- 1. A throwaway tenant with one security event against it.
  ---------------------------------------------------------------------
  DELETE FROM security_events WHERE source = 'drill/track-d/tenant-delete';
  -- ⚠️ THAT DELETE IS EXPECTED TO BE REFUSED IF ANY ROW MATCHES, which is
  -- why the drill uses a fixed tenant id and is safe to re-run only on a
  -- throwaway database. On a clean one it matches nothing and is a no-op.

  INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
  VALUES (probe_tenant, 'org_drill_track_d', 'drill-track-d', 'Drill — Track D',
          'active', 'advanced')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO security_events (tenant_id, event_type, severity, source, reason)
  VALUES (probe_tenant, 'anomaly.detected', 'warning',
          'drill/track-d/tenant-delete',
          'Drill: proving that this row makes its tenant undeletable.');

  RAISE NOTICE 'Drill: tenant % has one security event.', probe_tenant;

  ---------------------------------------------------------------------
  -- 2. Attempt the delete. It must be refused.
  ---------------------------------------------------------------------
  BEGIN
    DELETE FROM tenants WHERE id = probe_tenant;
  EXCEPTION
    WHEN insufficient_privilege OR raise_exception THEN
      blocked := true;
      GET STACKED DIAGNOSTICS err = MESSAGE_TEXT;
      RAISE NOTICE 'Drill: the DELETE was refused, as expected — %', err;
  END;

  ---------------------------------------------------------------------
  -- 3. The verdict. A drill that cannot fail proves nothing.
  ---------------------------------------------------------------------
  IF NOT blocked THEN
    RAISE EXCEPTION
      'DRILL FAILED IN THE INTERESTING DIRECTION: the tenant was deleted. '
      'That means the append-only trigger on security_events is gone, or the '
      'foreign key is no longer ON DELETE SET NULL. Either is a larger finding '
      'than the one this drill was written for — stop and investigate.';
  END IF;

  RAISE NOTICE
    'Drill PASSED: a tenant with security evidence cannot be deleted. '
    'Any tenant-purge design must route through prune_security_events() '
    'or change the foreign key.';
END $$;
