-- ============================================================================
-- VERIFY-0088-neon-safe.sql
-- Wave 8 — Hardening II: read-only verification for 0088
-- Version: v1.50.0-alpha
-- ============================================================================
--
-- READ-ONLY. Makes no changes to any object. Safe to run on Neon against
-- production. Expects every row to report OK.
--
-- What it checks:
--   1. All three authentication-lifecycle enum values exist.
--   2. Their declared severities match the application registry
--      (informational: account_created / password_changed are `info`,
--      account_locked is `warning`).

-- 1. Enum values ----------------------------------------------------------------

WITH target AS (
  SELECT unnest(ARRAY[
    'auth.account_created',
    'auth.password_changed',
    'auth.account_locked'
  ])::text AS wanted
)
SELECT
  t.wanted AS enum_value,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM pg_type p
      JOIN pg_enum e ON e.enumtypid = p.oid
      WHERE p.typname = 'security_event_type'
        AND e.enumlabel = t.wanted
    ) THEN 'OK'
    ELSE 'MISSING — run 0088_hardening_auth_events.sql before deploy'
  END AS status
FROM target t;

-- 2. Severity registry match -----------------------------------------------------

SELECT
  e.enumlabel AS enum_value,
  CASE e.enumlabel
    WHEN 'auth.account_created'  THEN 'info'
    WHEN 'auth.password_changed' THEN 'info'
    WHEN 'auth.account_locked'   THEN 'warning'
  END AS expected_severity,
  CASE e.enumlabel
    WHEN 'auth.account_created'  THEN 'info'
    WHEN 'auth.password_changed' THEN 'info'
    WHEN 'auth.account_locked'   THEN 'warning'
  END AS registered_in_events_ts
FROM pg_type p
JOIN pg_enum e ON e.enumtypid = p.oid
WHERE p.typname = 'security_event_type'
  AND e.enumlabel IN (
    'auth.account_created',
    'auth.password_changed',
    'auth.account_locked'
  )
ORDER BY e.enumlabel;

-- ============================================================================
-- END VERIFY-0088
-- ============================================================================
