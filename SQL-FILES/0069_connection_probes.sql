-- =====================================================================
--  ORDENCE — 0069 · THE PROBE, AND THE TEMPLATE A PERSON CAN REGISTER
--  Version: v1.17.0-alpha
--
--  ⚠️ RUN AFTER 0068. It touches `sync_runs` (0064) and
--  `message_templates` (0066), and does nothing that either of those
--  files does not already assume.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHY THIS FILE EXISTS AT ALL
--  ══════════════════════════════════════════════════════════════════
--  Sessions 4 to 8 built the integration frame, lead intake, utility
--  messaging, campaigns and the rhythm engine. Every one of them
--  compiled, every one of them was tested, and NOT ONE OF THEM COULD BE
--  REACHED FROM A BROWSER. `createConnection`, `saveCredential`,
--  `setConnectionActive`, `removeConnection`, `approveCampaign` and
--  `stopCampaign` were all written, all correct, and all called by
--  nothing.
--
--  ⚠️ v1.17.0 wires them to screens. This migration is the small amount
--  of schema that wiring turned out to need, and no more than that.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① A TEST IS A RUN, BUT NOT THE SAME KIND OF RUN
-- =====================================================================
--
--  ⭐ THE PROBE IS RECORDED IN `sync_runs` RATHER THAN A NEW TABLE,
--  because it genuinely is a run: it reads a credential, it calls a far
--  end, and it must be accounted for. `server/vault/secrets.ts` refuses
--  to hand a credential to anything that cannot name the run it belongs
--  to, and that rule is worth more than the convenience of a separate
--  table would have been.
--
--  🔴 BUT IT MUST BE DISTINGUISHABLE, FOR TWO REASONS.
--
--  ① THE BAD MORNING. The runs list is read when enquiries have
--     stopped. Twenty setup attempts sitting at the top of it push the
--     actual failure off the screen, and the screen was the entire
--     point of building the log.
--
--  ② THE CURSOR. A real run advances `connections.cursor_at` on
--     success. A probe must never do that: marking a week of real
--     enquiries as already fetched loses them permanently, and nothing
--     reports it, because an empty pipeline and a quiet week look the
--     same. Flagging the row makes that rule checkable rather than
--     merely intended.
--
--  ⚠️ DEFAULT false, NOT NULL. A nullable column would make every row
--  written before today ambiguous in order to answer one question about
--  today.
ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS is_probe boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sync_runs.is_probe IS
  'True where a person pressed Test rather than the scheduler running. Never advances connections.cursor_at, and hidden from the runs list by default.';

--  ⭐ THE INDEX IS PARTIAL AND COVERS THE COMMON READ, WHICH IS
--  "the real runs for this connection, newest first".
--
--  ⚠️ A plain index on `is_probe` would be almost entirely one value and
--  would earn nothing. This one indexes only the rows the screen wants.
CREATE INDEX IF NOT EXISTS sync_runs_real_idx
  ON sync_runs (tenant_id, connection_id, started_at DESC)
  WHERE NOT is_probe;

-- =====================================================================
--  ② A PROBE MAY NOT MOVE THE CURSOR, ENFORCED RATHER THAN INTENDED
-- =====================================================================
--
--  🔴 THE COMMENT IN `probe.ts` SAYS A PROBE NEVER ADVANCES THE CURSOR.
--  A comment is a promise about code that exists today. This is the
--  same promise about code somebody writes in eighteen months.
--
--  ⚠️ IT CANNOT BE A CHECK CONSTRAINT, because the thing being forbidden
--  is a write to a DIFFERENT table. So it is a trigger on the probe row
--  itself: a probe that closes `success` while claiming to have seen
--  items is refused, since the only reason to count items on a probe is
--  that somebody has started ingesting from one.
CREATE OR REPLACE FUNCTION ordence_guard_probe_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_probe AND (
       COALESCE(NEW.items_new, 0) > 0
    OR COALESCE(NEW.items_duplicate, 0) > 0
  ) THEN
    RAISE EXCEPTION
      'A probe may look but not file. This run is marked is_probe and reports % new and % duplicate items, which means something ingested from a test. A probe that files enquiries also advances the cursor, and the enquiries it skips are lost silently.',
      NEW.items_new, NEW.items_duplicate
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_probe_scope ON sync_runs;
CREATE TRIGGER ordence_guard_probe_scope
  BEFORE INSERT OR UPDATE ON sync_runs
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_probe_scope();

-- =====================================================================
--  ③ THE TEMPLATE SOMEBODY TYPED IN, VERSUS THE ONE META APPROVED
-- =====================================================================
--
--  ⭐ 0066 BUILT `message_templates` FOR A SYNC THAT DOES NOT EXIST YET.
--  Every column assumed the row arrived from Meta's API: `synced_at`,
--  `quality`, `rejection_reason`, a status defaulting to `in_review`.
--
--  ⚠️ BUT THE FIRST TEMPLATE A TENANT HAS IS ONE THEY WROTE IN META'S
--  OWN DASHBOARD AND NOW HAVE TO TELL US ABOUT, BY HAND. Without a way
--  to record that, the utility messaging and campaign engines have no
--  template to name, and both are inert no matter how correct they are.
--
--  🔴 SO WE RECORD WHERE THE ROW CAME FROM, AND NEVER LET A HAND-TYPED
--  ROW MASQUERADE AS A CONFIRMED ONE.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'declared';

COMMENT ON COLUMN message_templates.source IS
  'declared = a person told us this template exists. synced = we read it back from the provider. A declared template is a claim; only a synced one is a fact.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_source_known'
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_source_known
      CHECK (source IN ('declared', 'synced'));
  END IF;
END;
$$;

--  🔴🔴 THE ONE THAT MATTERS. A HAND-TYPED ROW MAY NOT CLAIM APPROVAL.
--
--  ⚠️ THE FAILURE THIS PREVENTS IS EXPENSIVE AND SILENT. Somebody
--  registers a template, ticks "approved" because it looks approved on
--  Meta's dashboard, and a campaign of four thousand recipients resolves
--  against it. Meta refuses every send for a parameter mismatch, or
--  worse accepts them under a category it re-assigned to `marketing` at
--  roughly seven times the price.
--
--  ⭐ SO `approved` IS A STATE ONLY THE SYNC MAY WRITE. A person may say
--  a template exists. Only the provider may say it is approved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_only_sync_approves'
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_only_sync_approves
      CHECK (status <> 'approved' OR source = 'synced');
  END IF;
END;
$$;

-- =====================================================================
--  ④ WHO TOLD US, SO THE CLAIM HAS A NAME ON IT
-- =====================================================================
--
--  ⚠️ `created_by` already exists and is set to null on user delete,
--  which is right for a record but useless for a claim. This keeps the
--  moment a person asserted something we could not verify.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS declared_at timestamptz;

COMMENT ON COLUMN message_templates.declared_at IS
  'When a person asserted this template exists, as opposed to when we read it back. Null on a row that arrived from the provider.';

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  IT DOES NOT ADD A TABLE FOR THE SETUP WIZARD. The wizard writes to
--  `connections`, `webhook_endpoints` and `vault_secrets`, all of which
--  0064 already built correctly. A "connection_setup_progress" table was
--  drafted and deleted: the progress IS the data. A connection with no
--  credential is at step two, and asking the same question twice is how
--  the two answers start disagreeing.
--
--  IT DOES NOT STORE THE VERIFY TOKEN OUTSIDE THE VAULT. It is a
--  credential, it goes where credentials go, and it is returned to a
--  browser exactly once at the moment it is minted and never again.
-- =====================================================================
