-- =====================================================================
--  ORDENCE — VERIFY 0077 IN NEON
--  Version: v1.24.0-alpha
--
--  ⭐ READ-ONLY. Every statement is a SELECT. Safe on production, safe
--  to re-run.
--
--  ⚠️ NOT THE DRILL. The drill inserts bad rows to prove the
--  constraints refuse them; its filename says where it must never run.
--
--  Paste this whole file into the Neon SQL editor and press Run. Six
--  tabs; every one should read "yes" or "0".
-- =====================================================================

-- ① The table
SELECT 'table' AS check_name, table_name, 'yes' AS present
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'gst_returns';

-- ② The enum
SELECT 'enum' AS check_name, t.typname AS enum_name,
       string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS values
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE t.typname = 'gst_return_status'
 GROUP BY t.typname;

-- ③ The constraints
SELECT 'constraints' AS check_name, conname AS constraint_name, 'yes' AS present
  FROM pg_constraint
 WHERE conname IN (
   'gst_returns_period_ordered',
   'gst_returns_period_shape',
   'gst_returns_filed_has_arn',
   'gst_returns_supersede_explained',
   'gst_returns_cash_adds_up'
 )
 ORDER BY conname;

-- ④ 🔴 The index that stops one month being filed twice
SELECT 'unique index' AS check_name, indexname, 'yes' AS present
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN ('gst_returns_one_live_per_period', 'gst_returns_id_tenant_key')
 ORDER BY indexname;

-- ⑤ The freeze, and RLS
SELECT 'guard' AS check_name,
       t.tgname AS trigger_name,
       CASE WHEN c.relrowsecurity THEN 'yes' ELSE 'NO' END AS rls_enabled,
       CASE WHEN c.relforcerowsecurity THEN 'yes' ELSE 'NO' END AS rls_forced
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname = 'ordence_guard_filed_return';

SELECT 'policy' AS check_name,
       policyname,
       CASE WHEN qual LIKE '%app_platform_scope%' THEN 'yes' ELSE 'NO' END
         AS using_has_platform_scope,
       CASE WHEN coalesce(with_check, '') LIKE '%app_platform_scope%'
            THEN 'NO — house rule broken' ELSE 'yes' END AS with_check_is_clean
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'gst_returns';

-- ⑥ ⭐ Nothing junk landed
--
--  Both counts should be 0 on a database where no return has been
--  prepared. `drill_leftovers` would only be non-zero if the drill had
--  been run here, which it must never be.
SELECT 'row counts' AS check_name,
       (SELECT count(*) FROM gst_returns) AS returns,
       (SELECT count(*) FROM gst_returns
         WHERE gstin IN ('29ABCDE1234F1Z5','27ABCDE1234F1Z5','29ZZZZZ1234F1Z5','29PLATF1234F1Z5'))
         AS drill_leftovers;
