-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 6 · SENSITIVE-DATA VAULT
-- File 0037 · v0.66.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT ASSUMES THE DATABASE ITSELF WILL LEAK
-- ══════════════════════════════════════════════════════════════════════
-- Every other engine trusts row-level security, and is right to. RLS
-- answers "which tenant may read this row" and answers it well.
--
-- ⚠️ IT DOES NOT ANSWER "SHOULD A PLAINTEXT PAN EXIST IN A BACKUP AT
-- ALL", AND THAT IS A DIFFERENT QUESTION WITH DIFFERENT CONSEQUENCES.
--
-- A leaked backup, a mis-scoped read replica, a support engineer with a
-- psql prompt, a prompt built by concatenating a table into an LLM
-- request — a row-level policy stops none of these. So the vault assumes
-- all of them happen and holds nothing that would matter if they did.
--
-- ⚠️ FIVE THINGS IN THIS FILE ARE LOAD-BEARING:
--
--   1. CIPHERTEXT ONLY, AND THE KEY IS NOT HERE. Not pgcrypto:
--      `pgp_sym_encrypt(x, 'key')` writes the key into
--      pg_stat_statements and into the slow-query log, so the data ends
--      up encrypted at rest with the key filed beside it. Encryption
--      whose key travels with the ciphertext is theatre.
--
--   2. THE SEARCHABLE COLUMN IS AN HMAC, NOT A HASH. The PAN space is
--      about 10^9; a laptop enumerates a SHA-256 column in minutes, so a
--      plain hash IS the PAN to whoever obtains it. The pepper lives in
--      Cloudflare and never in this database, which makes the same table
--      inert without it.
--
--   3. A READ IS A WRITE. Every decryption appends an access-log row
--      naming who, what and WHY. No policy stops a person entitled to
--      read one record from reading four thousand; only a log makes it
--      visible the next morning.
--
--   4. THE ACCESS LOG CANNOT BE DELETED BY ANYONE THE APPLICATION USES.
--      A log the application can prune will be pruned by exactly the
--      person it was built to catch.
--
--   5. ERASURE ZEROES THE CIPHERTEXT AND KEEPS THE ROW. The row is the
--      PROOF that erasure happened, and to what. A deleted row leaves an
--      absence, which is indistinguishable from never having recorded it
--      — and from having quietly moved it somewhere else.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vault_secrets', 'vault_access_log', 'vault_consents'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE EXCEPTION
        '% is missing. Run `drizzle-kit push` (or deploy) before this file.', t;
    END IF;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 1 · ROW-LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ RLS IS THE SECOND LINE HERE, NOT THE FIRST. It still matters — it
-- keeps one tenant's ciphertext and, more importantly, one tenant's
-- ACCESS LOG out of another's reach. But the design does not depend on
-- it, which is the whole point of the engine.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vault_secrets', 'vault_access_log', 'vault_consents'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename=t
         AND policyname = t || '_tenant_isolation'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY %I ON %I
          USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      $f$, t || '_tenant_isolation', t);
    END IF;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 2 · FOREIGN KEYS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE ACCESS LOG DOES **NOT** HAVE A CASCADING FOREIGN KEY TO THE
-- SECRET, AND THAT IS DELIBERATE.
--
-- Deleting a vault row must not delete the record of who read it. The
-- moment a secret disappears is precisely the moment its access history
-- becomes most interesting, and a CASCADE would make "delete the secret"
-- a one-statement way to erase the evidence of having read it.
--
-- The log therefore copies the fields it needs (kind, owner) rather than
-- joining for them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vault_secrets_supersedes_tenant_fk') THEN
    ALTER TABLE vault_secrets
      ADD CONSTRAINT vault_secrets_supersedes_tenant_fk
      FOREIGN KEY (supersedes_id, tenant_id)
      REFERENCES vault_secrets (id, tenant_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vault_secrets_no_self_supersede') THEN
    ALTER TABLE vault_secrets
      ADD CONSTRAINT vault_secrets_no_self_supersede
      CHECK (supersedes_id IS NULL OR supersedes_id <> id);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ NO PLAINTEXT MAY BE STORED, AND THE DATABASE CHECKS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE MOST LIKELY WAY THIS ENGINE FAILS IS NOT AN ATTACKER. It is a
-- developer in a hurry writing `ciphertext: pan` because the encryption
-- helper was two imports away and the deadline was yesterday. Nothing
-- errors. The column is named ciphertext, the code reads plausibly, and
-- the review passes.
--
-- So the DATABASE refuses a value that still looks like the thing it was
-- supposed to protect. A real AES-GCM ciphertext is base64 and does not
-- match a PAN or an Aadhaar pattern; a plaintext PAN does. This costs one
-- regex per insert and closes the failure mode that actually happens.

CREATE OR REPLACE FUNCTION vault_reject_plaintext()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- An erased row is legitimately empty.
  IF NEW.status = 'erased' THEN
    RETURN NEW;
  END IF;

  IF NEW.ciphertext IS NULL OR length(NEW.ciphertext) < 16 THEN
    RAISE EXCEPTION
      'vault_secrets.ciphertext is too short to be an encrypted value. This column holds AES-GCM output produced in the Worker — never the raw value. If you are seeing this, the encryption step was skipped.';
  END IF;

  /* ⚠️ A PAN IS FIVE LETTERS, FOUR DIGITS, A LETTER — AND NOTHING ELSE.
   * Ciphertext never looks like that. */
  IF NEW.ciphertext ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
    RAISE EXCEPTION
      'A raw PAN was passed to vault_secrets.ciphertext. Encrypt it in the Worker first — this column is included in every database backup, and a value stored here in the clear is a value published to every copy of that backup.';
  END IF;

  /* ⚠️ AADHAAR: 12 digits, first digit 2–9 by UIDAI's own numbering.
   * This one is worth its own branch — it is the identifier Indian
   * regulators are most specific about and its misuse carries a named
   * penalty. */
  IF regexp_replace(NEW.ciphertext, '[\s-]', '', 'g') ~ '^[2-9][0-9]{11}$' THEN
    RAISE EXCEPTION
      'A raw Aadhaar number was passed to vault_secrets.ciphertext. It must be encrypted before it reaches the database, and only its last four digits may ever be displayed.';
  END IF;

  /* ⚠️ THE BLIND INDEX MUST BE AN HMAC, WHICH IS 64 HEX CHARACTERS. A
   * shorter value is somebody storing a truncated hash, or the raw value
   * itself — either of which defeats the column's whole purpose. */
  IF NEW.blind_index IS NOT NULL AND NEW.blind_index !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION
      'vault_secrets.blind_index must be a 64-character hex HMAC-SHA256 under the server-side pepper. A plain hash of a PAN is not a protection: the PAN space is about 10^9 and a laptop enumerates it in minutes, so the hash IS the PAN to anyone who obtains this column.';
  END IF;

  /* The masked display must not BE the value. */
  IF NEW.masked_display IS NOT NULL
     AND NEW.masked_display !~ '[•*X]'
     AND length(NEW.masked_display) > 6 THEN
    RAISE EXCEPTION
      'vault_secrets.masked_display contains no masking characters and is long enough to be the full value. Only the permitted suffix may be shown — four digits for an identifier, none at all for a password.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vault_secrets_010_reject_plaintext ON vault_secrets;
CREATE TRIGGER trg_vault_secrets_010_reject_plaintext
  BEFORE INSERT OR UPDATE ON vault_secrets
  FOR EACH ROW EXECUTE FUNCTION vault_reject_plaintext();


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ ERASURE THAT ACTUALLY ERASES
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ "MARK IT DELETED" IS THE DEFAULT INSTINCT AND IT IS THE WRONG ONE
-- HERE. A `deleted_at` timestamp beside intact ciphertext is a row that
-- reports as compliant while the data sits exactly where it was — the
-- worst outcome available, because it is indistinguishable from having
-- done the work.
--
-- So erasure is a function that zeroes the ciphertext, drops the blind
-- index (which is itself a searchable derivative of the value) and
-- records why. The row survives as the receipt.

CREATE OR REPLACE FUNCTION ordence_vault_erase(
  p_tenant_id uuid,
  p_secret_id uuid,
  p_reason    text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE s RECORD;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION
      'Erasure requires a stated reason of at least 10 characters. "Which records did you erase, and on what basis" is the question a regulator asks, and the answer has to be in the row.';
  END IF;

  SELECT id, status, kind INTO s
    FROM vault_secrets
   WHERE id = p_secret_id AND tenant_id = p_tenant_id;

  IF s IS NULL THEN
    RAISE EXCEPTION 'Vault record % does not exist in this workspace.', p_secret_id;
  END IF;

  IF s.status = 'erased' THEN
    RETURN;  -- Idempotent: erasing twice is not an error.
  END IF;

  UPDATE vault_secrets
     SET ciphertext     = '',
         iv             = '',
         -- ⚠️ THE BLIND INDEX GOES TOO. It is a deterministic derivative
         -- of the value; leaving it behind means "is this person's PAN in
         -- your system" is still answerable about a record you certified
         -- as erased.
         blind_index    = NULL,
         masked_display = NULL,
         status         = 'erased',
         erased_at      = now(),
         erased_reason  = p_reason,
         updated_at     = now()
   WHERE id = p_secret_id AND tenant_id = p_tenant_id;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ RECORDING AN ACCESS — AND THE COUNTER THAT MAKES IT VISIBLE
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE COUNTER ON THE SECRET IS NOT A DUPLICATE OF THE LOG. The log
-- will have millions of rows; "has this particular record been read 400
-- times this week" must be answerable without scanning it, or nobody will
-- ever ask.

CREATE OR REPLACE FUNCTION vault_access_bump_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.was_decrypted THEN
    UPDATE vault_secrets
       SET access_count     = access_count + 1,
           last_accessed_at = NEW.accessed_at
     WHERE id = NEW.secret_id AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_vault_access_bump ON vault_access_log;
CREATE TRIGGER trg_vault_access_bump
  AFTER INSERT ON vault_access_log
  FOR EACH ROW EXECUTE FUNCTION vault_access_bump_counter();


-- ══════════════════════════════════════════════════════════════════════
-- 6 · ⭐ THE ACCESS LOG IS APPEND-ONLY, AND SUPPORT IS FENCED OUT
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ SUPPORT EXISTS TO FIX A BROKEN SCREEN, NOT TO READ A PAN.
--
-- The platform's impersonation feature is a legitimate and necessary
-- tool — somebody has to be able to see what the customer sees. It is
-- also, by construction, a way for a platform employee to act inside a
-- tenant. Letting that path decrypt KYC, clinical identifiers or bulk
-- exports would make every other control in this file decorative, and
-- "they would not do that" is not a control.

CREATE OR REPLACE FUNCTION vault_access_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'The vault access log cannot be % — not by anyone, for any reason. A log that can be pruned will be pruned by exactly the person it was built to catch.',
    lower(TG_OP);
END $$;

DROP TRIGGER IF EXISTS trg_vault_access_log_immutable ON vault_access_log;
CREATE TRIGGER trg_vault_access_log_immutable
  BEFORE UPDATE OR DELETE ON vault_access_log
  FOR EACH ROW EXECUTE FUNCTION vault_access_log_immutable();


CREATE OR REPLACE FUNCTION vault_access_guard_impersonation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- ⚠️ MUST MATCH PURPOSES_FORBIDDEN_DURING_IMPERSONATION in
  -- db/schema/vault.ts. The test suite asserts the two lists are equal.
  IF NEW.via_impersonation
     AND NEW.purpose::text = ANY(/*IMPERSONATION-FORBIDDEN*/ ARRAY['bulk_export','kyc_verification','clinical_care'])
  THEN
    RAISE EXCEPTION
      'A platform support session cannot decrypt vault data for "%". Support exists to fix a broken screen, not to read identity or clinical data. Ask the customer to perform this action themselves.',
      NEW.purpose;
  END IF;

  /* ⚠️ A DECRYPTION OF AN ERASED RECORD SHOULD NOT BE POSSIBLE, and if
   * it is being logged then something is reading a value that is
   * supposed to be gone. Loud, because silence here means the erasure
   * did not take. */
  IF NEW.was_decrypted AND EXISTS (
    SELECT 1 FROM vault_secrets
     WHERE id = NEW.secret_id AND tenant_id = NEW.tenant_id
       AND status = 'erased'
  ) THEN
    RAISE EXCEPTION
      'Vault record % is erased and cannot be decrypted. If something produced a plaintext value from it, the erasure did not take — investigate before doing anything else.',
      NEW.secret_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vault_access_guard ON vault_access_log;
CREATE TRIGGER trg_vault_access_guard
  BEFORE INSERT ON vault_access_log
  FOR EACH ROW EXECUTE FUNCTION vault_access_guard_impersonation();


-- ══════════════════════════════════════════════════════════════════════
-- 7 · ⭐ CONSENT WITHDRAWAL IS A ROW, NOT A DELETE
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ "CONSENTED ON 4 MARCH, WITHDREW ON 11 SEPTEMBER" IS THE THING THAT
-- HAS TO BE PROVABLE — BOTH HALVES. Deleting the consent row on
-- withdrawal destroys the evidence that everything done between those
-- dates was lawful, which is exactly the period anyone would ask about.

CREATE OR REPLACE FUNCTION vault_consent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A consent record cannot be deleted. Withdrawal is recorded by setting withdrawn_at — deleting the row destroys the evidence that processing before that date was lawful.';
  END IF;

  /* The notice wording IS the consent. Editing it retroactively changes
   * what the person is recorded as having agreed to. */
  IF NEW.notice_text IS DISTINCT FROM OLD.notice_text
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION
      'The notice text, its version and the grant date cannot be changed once recorded — they are what the person actually agreed to. Record a NEW consent against the new notice instead.';
  END IF;

  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION
      'A withdrawn consent cannot be un-withdrawn. If the person has consented again, record a new consent.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vault_consents_guard ON vault_consents;
CREATE TRIGGER trg_vault_consents_guard
  BEFORE UPDATE OR DELETE ON vault_consents
  FOR EACH ROW EXECUTE FUNCTION vault_consent_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 8 · VIEWS
-- ══════════════════════════════════════════════════════════════════════

/**
 * ⭐ WHAT IS OVERDUE FOR ERASURE.
 *
 * ⚠️ A RETENTION POLICY THAT LIVES IN A DOCUMENT IS A RETENTION POLICY
 * NOBODY EXECUTES. Stating the date on the row turns "what should we no
 * longer be holding" into a query somebody can run — and, later, into a
 * scheduled job.
 *
 * ⚠️ NOTE THIS VIEW EXPOSES NO CIPHERTEXT AND NO BLIND INDEX. A screen
 * about deletion has no business carrying the values it is about.
 */
CREATE OR REPLACE VIEW v_vault_retention_due
WITH (security_invoker = true) AS
SELECT
  s.tenant_id,
  s.id            AS secret_id,
  s.kind,
  s.owner_kind,
  s.owner_id,
  s.label,
  s.retain_until,
  s.created_at,
  EXTRACT(DAY FROM (now() - s.retain_until))::integer AS days_overdue,
  s.access_count,
  s.last_accessed_at
FROM vault_secrets s
WHERE s.status = 'active'
  AND s.retain_until IS NOT NULL
  AND s.retain_until < now();

/**
 * ⭐ WHO HAS BEEN READING WHAT.
 *
 * ⚠️ THE ONLY CONTROL THAT EVER CATCHES THE INSIDER. Nothing stops a
 * person entitled to read one record from reading four thousand — the
 * permission is legitimately theirs. What catches it is somebody seeing,
 * the next morning, that they did.
 */
CREATE OR REPLACE VIEW v_vault_access_summary
WITH (security_invoker = true) AS
SELECT
  l.tenant_id,
  l.user_id,
  l.user_email,
  l.purpose,
  date_trunc('day', l.accessed_at)                        AS day,
  count(*)                                                AS reads,
  count(*) FILTER (WHERE l.was_decrypted)                 AS decryptions,
  count(DISTINCT l.secret_id)                             AS distinct_records,
  count(*) FILTER (WHERE l.via_impersonation)             AS via_support
FROM vault_access_log l
GROUP BY l.tenant_id, l.user_id, l.user_email, l.purpose,
         date_trunc('day', l.accessed_at);


-- ══════════════════════════════════════════════════════════════════════
-- 9 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GRANT DOES NOT NARROW — the REVOKEs below are not decoration. A
-- blanket `GRANT ALL ON ALL TABLES` run at any point in this database's
-- history would otherwise leave DELETE on the access log in place, and
-- nothing would report it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE ON vault_secrets  TO ordence_app;
    /* ⚠️ NO DELETE ON THE SECRET ITSELF. Removal is erasure — which
     * zeroes the ciphertext and KEEPS the row as the receipt. A DELETE
     * would leave an absence, and an absence proves nothing. */
    REVOKE DELETE, TRUNCATE ON vault_secrets FROM ordence_app;

    /* ⭐ THE ACCESS LOG: INSERT AND SELECT. NOTHING ELSE. EVER. */
    GRANT SELECT, INSERT ON vault_access_log TO ordence_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON vault_access_log FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE ON vault_consents TO ordence_app;
    REVOKE DELETE, TRUNCATE ON vault_consents FROM ordence_app;

    GRANT SELECT ON v_vault_retention_due  TO ordence_app;
    GRANT SELECT ON v_vault_access_summary TO ordence_app;

    GRANT EXECUTE ON FUNCTION ordence_vault_erase(uuid, uuid, text) TO ordence_app;
  END IF;
END $$;

COMMIT;
