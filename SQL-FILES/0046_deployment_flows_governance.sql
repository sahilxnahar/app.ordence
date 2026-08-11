-- =====================================================================
-- ORDENCE · 0046 — DEPLOYMENT, FLOWS & GOVERNANCE
-- =====================================================================
-- Replaces three files that were generated without RLS and with
-- impossible numbering:
--
--     SQL-FILES/0062_security_batches.sql
--     SQL-FILES/0072_quick_flows.sql
--     SQL-FILES/0076_mass_deployment_backup.sql
--
-- ⚠️ WHY THEY WERE REPLACED RATHER THAN PATCHED
--
-- 1. NO ROW-LEVEL SECURITY. All four tables carried a `tenant_id` column
--    and nothing else — no ENABLE, no FORCE, no policy. In this codebase
--    RLS *is* the tenant boundary: `withTenant()` pins
--    `app.current_tenant_id` and every policy reads it. A tenant_id
--    column with no policy behind it is not isolation, it is a column.
--    Any tenant could have read every other tenant's rows.
--
-- 2. IMPOSSIBLE NUMBERING. They were numbered 0062, 0072 and 0076 when
--    the highest existing migration is 0045. Files 0046-0061, 0063-0071
--    and 0073-0075 do not exist and never will, so "run these in order"
--    stopped meaning anything.
--
-- 3. They also skipped the `(id, tenant_id)` composite unique key that
--    every other table here carries, which is what makes composite
--    foreign keys possible later.
--
-- ⚠️ THE POLICY SHAPE IS NOT INVENTED HERE. It matches the existing
-- tables exactly:
--
--     USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
--     WITH CHECK (tenant_id = app_current_tenant_id())
--
-- `app_platform_scope()` appears in USING and NEVER in WITH CHECK. That
-- asymmetry is deliberate and is documented on `withPlatformScope()` in
-- `db/index.ts`: platform staff may READ across tenants for support and
-- webhook resolution, and may never WRITE across them. The verification
-- query in 0014 flags any policy missing the USING half, so a table
-- without it would be reported as a defect.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · DEPLOYMENT RELEASES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployment_releases (
    id          uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id   uuid NOT NULL,

    version     varchar(40) NOT NULL,
    status      varchar(30) NOT NULL DEFAULT 'prepared',
    manifest    jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes       text,

    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL,
    deleted_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_releases_pkey
  ON public.deployment_releases (id);

-- The composite key every tenant table here carries, so a later child
-- table can use a composite FK and be unable to reference across tenants.
CREATE UNIQUE INDEX IF NOT EXISTS deployment_releases_id_tenant_key
  ON public.deployment_releases (id, tenant_id);

CREATE INDEX IF NOT EXISTS deployment_releases_tenant_idx
  ON public.deployment_releases (tenant_id, created_at DESC);

-- One row per version per tenant. A retried deploy must not create a
-- second release for the same version.
CREATE UNIQUE INDEX IF NOT EXISTS deployment_releases_tenant_version_key
  ON public.deployment_releases (tenant_id, version)
  WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------
-- 2 · DEPLOYMENT BACKUPS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployment_backups (
    id           uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id    uuid NOT NULL,

    release_id   uuid,
    backup_type  varchar(60) NOT NULL,
    status       varchar(30) NOT NULL DEFAULT 'recorded',
    location     text,
    size_bytes   bigint,
    metadata     jsonb DEFAULT '{}'::jsonb NOT NULL,

    created_at   timestamptz DEFAULT now() NOT NULL,
    deleted_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_backups_pkey
  ON public.deployment_backups (id);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_backups_id_tenant_key
  ON public.deployment_backups (id, tenant_id);

CREATE INDEX IF NOT EXISTS deployment_backups_tenant_idx
  ON public.deployment_backups (tenant_id, created_at DESC);


-- ---------------------------------------------------------------------
-- 3 · UI GOVERNANCE CHECKS  (the 460-batch tracker)
-- ---------------------------------------------------------------------
-- ⚠️ This table was referenced by the batch plan as the thing that tracks
-- all 460 batches, and it had never been created in any migration. The
-- plan named it; nothing defined it.
--
-- `batch_key` is CI-01 … CI-60, CT-01 …, UX-01 …, CP-01 …, AL-01 …,
-- IQ-01 …, CUS-01 …, plus S1 … S40 for the security track.
CREATE TABLE IF NOT EXISTS public.ui_governance_checks (
    id           uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id    uuid NOT NULL,

    batch_key    varchar(20) NOT NULL,
    department   varchar(40) NOT NULL,
    title        text NOT NULL,
    status       varchar(30) NOT NULL DEFAULT 'todo',
    notes        text,

    checked_by   uuid,
    checked_at   timestamptz,

    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_at   timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ui_governance_checks_pkey
  ON public.ui_governance_checks (id);

CREATE UNIQUE INDEX IF NOT EXISTS ui_governance_checks_id_tenant_key
  ON public.ui_governance_checks (id, tenant_id);

-- One row per batch per tenant. This is what makes the tracker idempotent
-- when a seed script is re-run.
CREATE UNIQUE INDEX IF NOT EXISTS ui_governance_checks_tenant_batch_key
  ON public.ui_governance_checks (tenant_id, batch_key);

CREATE INDEX IF NOT EXISTS ui_governance_checks_tenant_status_idx
  ON public.ui_governance_checks (tenant_id, department, status);


-- ---------------------------------------------------------------------
-- 4 · FLOW SUBMISSIONS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flow_submissions (
    id          uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id   uuid NOT NULL,

    user_id     uuid,
    flow_type   varchar(60) NOT NULL,
    title       text NOT NULL,
    status      varchar(30) NOT NULL DEFAULT 'submitted',
    payload     jsonb DEFAULT '{}'::jsonb NOT NULL,

    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL,
    deleted_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS flow_submissions_pkey
  ON public.flow_submissions (id);

CREATE UNIQUE INDEX IF NOT EXISTS flow_submissions_id_tenant_key
  ON public.flow_submissions (id, tenant_id);

CREATE INDEX IF NOT EXISTS flow_submissions_tenant_idx
  ON public.flow_submissions (tenant_id, flow_type, created_at DESC);


-- ---------------------------------------------------------------------
-- 5 · FOREIGN KEYS
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'deployment_releases',
    'deployment_backups',
    'ui_governance_checks',
    'flow_submissions'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = t || '_tenant_id_fkey'
         AND table_name = t
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I
           FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        t, t || '_tenant_id_fkey'
      );
    END IF;
  END LOOP;
END $$;

-- ⚠️ COMPOSITE FK, not a plain one. `(release_id, tenant_id)` against
-- `(id, tenant_id)` makes it structurally impossible for a backup row to
-- point at another tenant's release — the database refuses it rather than
-- relying on the application remembering to filter.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'deployment_backups_release_fkey'
       AND table_name = 'deployment_backups'
  ) THEN
    ALTER TABLE public.deployment_backups
      ADD CONSTRAINT deployment_backups_release_fkey
      FOREIGN KEY (release_id, tenant_id)
      REFERENCES public.deployment_releases (id, tenant_id)
      ON DELETE SET NULL;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 6 · ROW-LEVEL SECURITY  ← the whole point of this file
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'deployment_releases',
    'deployment_backups',
    'ui_governance_checks',
    'flow_submissions'
  ]
  LOOP
    -- ENABLE alone is not enough: it does not apply to the table OWNER,
    -- and the application connects as the owner on Neon. FORCE is the
    -- half that actually binds us.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = t
         AND policyname = t || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I
           USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
           WITH CHECK (tenant_id = app_current_tenant_id())',
        t || '_tenant_isolation', t
      );
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- 7 · VERIFICATION — run this and read the output
-- ---------------------------------------------------------------------
-- Every row must report PASS. A FAIL here means a table is readable
-- across tenants; do not deploy past it.
SELECT
  c.relname                                              AS table_name,
  CASE WHEN c.relrowsecurity  THEN 'PASS' ELSE 'FAIL' END AS rls_enabled,
  CASE WHEN c.relforcerowsecurity THEN 'PASS' ELSE 'FAIL' END AS rls_forced,
  CASE WHEN EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = c.relname
           AND p.qual LIKE '%app_current_tenant_id%'
       ) THEN 'PASS' ELSE 'FAIL' END                      AS tenant_policy,
  CASE WHEN EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = c.relname
           AND p.qual LIKE '%app_platform_scope%'
       ) THEN 'PASS' ELSE 'FAIL' END                      AS platform_read,
  -- Platform scope must NOT appear in WITH CHECK: read across tenants is
  -- allowed, write across tenants is not.
  CASE WHEN EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = c.relname
           AND p.with_check LIKE '%app_platform_scope%'
       ) THEN 'FAIL' ELSE 'PASS' END                      AS no_cross_tenant_write
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'deployment_releases',
    'deployment_backups',
    'ui_governance_checks',
    'flow_submissions'
  )
ORDER BY c.relname;
