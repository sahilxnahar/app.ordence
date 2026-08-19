-- ============================================================================
-- 0088_hardening_auth_events.sql
-- Wave 8 — Hardening II: authentication evidence vocabulary
-- Version: v1.50.0-alpha
-- ============================================================================
--
-- WHAT THIS FILE DOES
--
-- The application's security-event table (`security_events`) carries a
-- closed enum, `security_event_type`. Wave 8 introduces three
-- authentication-lifecycle events that the codebase now records:
--
--   auth.account_created   — a brand-new identity arrived via Clerk sign-up.
--                            Presence in the table is itself evidence: the
--                            platform knows about every identity.
--   auth.password_changed  — the credential was rotated (Clerk
--                            `user.updated` carrying `password` in
--                            `updated_attributes`). Prior sessions are
--                            thereafter suspect; this row is the paper
--                            trail that makes that claim reviewable.
--   auth.account_locked    — the identity exceeded the lockout threshold
--                            (see Wave 8 lockout module, `lib/security/lockout.ts`).
--
-- WHY SEPARATE FILE, WHY NOW
--
-- ⚠️ THIS PARAGRAPH USED TO OPEN WITH A RULE THAT DOES NOT EXIST:
-- "Postgres only permits one `ALTER TYPE ... ADD VALUE` per
-- transaction." It does not, and it never did. The real restriction —
-- and the one that produced the folklore — is that before PostgreSQL 12
-- `ALTER TYPE ... ADD VALUE` could not run inside a transaction block AT
-- ALL ("cannot run inside a transaction block", 25001). PG12 lifted
-- that; what remains on PG12+ is narrower still: a value added in a
-- transaction cannot be USED in that same transaction unless the enum
-- type itself was created there. Adding three values in one transaction,
-- as this file does, has always been fine.
--
-- 🔴 WHY THE CORRECTION IS WORTH THE SPACE. The invented rule tells the
-- next person to split enum growth across files for no reason, and it
-- points their attention at the wrong hazard: the hazard is not the
-- COUNT of additions, it is USING a value in the transaction that added
-- it. Nothing here does that — the application image is deployed after
-- this file, not inside it (see DEPLOYMENT ORDER below).
--
-- The three values belong together because they are one wave. Each block
-- is independently idempotent, so a partial re-run cannot leave the type
-- in a broken state (an enum value that already exists is simply
-- skipped).
--
-- DEPLOYMENT ORDER
--
-- Apply this file BEFORE deploying the v1.50.0-alpha application image:
-- the application code assumes all three values exist. Running it after
-- is safe but produces spurious `invalid input value for enum` errors
-- until the image is redeployed.

BEGIN;

-- auth.account_created ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'security_event_type'
      AND e.enumlabel = 'auth.account_created'
  ) THEN
    ALTER TYPE security_event_type ADD VALUE 'auth.account_created';
  END IF;
END $$;

-- auth.password_changed ---------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'security_event_type'
      AND e.enumlabel = 'auth.password_changed'
  ) THEN
    ALTER TYPE security_event_type ADD VALUE 'auth.password_changed';
  END IF;
END $$;

-- auth.account_locked -----------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'security_event_type'
      AND e.enumlabel = 'auth.account_locked'
  ) THEN
    ALTER TYPE security_event_type ADD VALUE 'auth.account_locked';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- END 0088
-- ============================================================================
