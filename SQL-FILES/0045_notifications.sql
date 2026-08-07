-- =====================================================================
-- ORDENCE · 0045 — NOTIFICATIONS
-- =====================================================================
-- Per-tenant notification center. Surfaces insights from background
-- intelligence workers, system events, and user actions.
--
-- ⚠️ TENANT-SCOPED, RLS-PROTECTED — same shape as every other tenant table.
-- ⚠️ APPEND-ONLY INSERT. A notification is created by the system and can
--    be marked read or dismissed, but never edited or deleted.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · THE TABLE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id            uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id     uuid NOT NULL,

    user_id       uuid,

    category      varchar(40) NOT NULL,
    severity      varchar(20) NOT NULL DEFAULT 'info',
    title         varchar(200) NOT NULL,
    body          text,
    action_url    varchar(500),

    metadata      jsonb DEFAULT '{}'::jsonb NOT NULL,
    source        varchar(60),

    read_at       timestamptz,
    dismissed_at  timestamptz,
    expires_at    timestamptz,

    created_at    timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_pkey
  ON public.notifications (id);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_id_tenant_key
  ON public.notifications (id, tenant_id);

CREATE INDEX IF NOT EXISTS notifications_tenant_unread_idx
  ON public.notifications (tenant_id, read_at, created_at);

CREATE INDEX IF NOT EXISTS notifications_tenant_category_idx
  ON public.notifications (tenant_id, category, created_at);

CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON public.notifications (user_id, created_at);


-- ---------------------------------------------------------------------
-- 2 · FOREIGN KEY
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'notifications_tenant_id_fkey'
       AND table_name = 'notifications'
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
      ON DELETE CASCADE;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3 · ROW-LEVEL SECURITY
-- ---------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY';

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'notifications'
       AND policyname = 'notifications_tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY notifications_tenant_isolation ON public.notifications
        USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    $f$;
  END IF;
END $$;
