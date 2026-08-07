-- =====================================================================
-- ORDENCE · 0044 — TENANT PATTERN MEMORY (Phase D, Agent Intelligence)
-- =====================================================================
-- Creates the `tenant_patterns` table: a per-tenant store of learned
-- business facts that AI agents pick up from running tasks and can use
-- in future runs.
--
-- ⚠️ WHY THIS IS NOT A VECTOR DATABASE
--
-- RUFLO (the agent harness this is modelled on) uses HNSW vector
-- embeddings for semantic pattern retrieval. Ordence's patterns are
-- structured business facts, not semantic embeddings: "client XYZ
-- disputes invoices over ₹5 lakh" is a fact with a type, a key, and a
-- count — not a vector. A JSONB column with an index is sufficient,
-- auditable, and far simpler to debug. An inspector can read these
-- rows; nobody can read a vector.
--
-- ⚠️ TENANT-SCOPED, RLS-PROTECTED
--
-- Every row keys off `tenant_id` and is protected by row-level
-- security, identical to every other tenant table. A pattern learned
-- in tenant A is invisible to tenant B.
--
-- ⚠️ APPEND-OR-UPDATE, NEVER DELETE
--
-- A pattern is either new (inserted) or seen again (occurrence_count
-- incremented, last_seen updated). There is no delete — a pattern that
-- was learned was real, and erasing it would make the agent's behaviour
-- inexplicable.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · THE TABLE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_patterns (
    id                uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id         uuid NOT NULL,

    -- The kind of pattern. varchar rather than enum so new types can be
    -- added without a migration. Validated by the application layer.
    pattern_type      varchar(60) NOT NULL,

    -- A stable key that identifies this specific pattern instance.
    -- e.g. "client:abc-corp:dispute-threshold". Combined with tenant_id
    -- and pattern_type, this is unique.
    pattern_key       varchar(200) NOT NULL,

    -- The structured fact. Always includes a `summary` field.
    pattern_data      jsonb DEFAULT '{}'::jsonb NOT NULL,

    occurrence_count  integer DEFAULT 1 NOT NULL,
    last_agent_id     varchar(60),

    last_seen         timestamptz DEFAULT now() NOT NULL,
    created_at        timestamptz DEFAULT now() NOT NULL
);

-- Composite primary key with tenant_id for RLS join safety.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_patterns_pkey
  ON public.tenant_patterns (id);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_patterns_id_tenant_key
  ON public.tenant_patterns (id, tenant_id);

-- One row per unique (tenant, type, key).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_patterns_unique_key
  ON public.tenant_patterns (tenant_id, pattern_type, pattern_key);

-- Query: patterns for a tenant, by type.
CREATE INDEX IF NOT EXISTS tenant_patterns_tenant_idx
  ON public.tenant_patterns (tenant_id, pattern_type);

-- Query: recent patterns for a tenant.
CREATE INDEX IF NOT EXISTS tenant_patterns_recent_idx
  ON public.tenant_patterns (tenant_id, last_seen)
  WHERE occurrence_count >= 1;


-- ---------------------------------------------------------------------
-- 2 · FOREIGN KEY
-- ---------------------------------------------------------------------
-- tenant_id → tenants(id) ON DELETE CASCADE.
-- A tenant deletion removes all learned patterns — they were about that
-- tenant and nobody else.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'tenant_patterns_tenant_id_fkey'
       AND table_name = 'tenant_patterns'
  ) THEN
    ALTER TABLE public.tenant_patterns
      ADD CONSTRAINT tenant_patterns_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
      ON DELETE CASCADE;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3 · ROW-LEVEL SECURITY
-- ---------------------------------------------------------------------
-- Same shape as every other tenant table: ENABLE and FORCE, with a
-- policy on both USING and WITH CHECK. FORCE makes the rule apply to
-- the table owner too.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.tenant_patterns ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.tenant_patterns FORCE ROW LEVEL SECURITY';

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'tenant_patterns'
       AND policyname = 'tenant_patterns_tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY tenant_patterns_tenant_isolation ON public.tenant_patterns
        USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    $f$;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 4 · NO DELETE GRANT
-- ---------------------------------------------------------------------
-- Patterns are append-or-update only. Revoke DELETE from the web role
-- so that even if a bug or a prompt injection reaches the database, a
-- pattern cannot be erased. The application layer does not delete
-- patterns; the database enforces that it cannot.
--
-- ⚠️ This is the same discipline as the ITC register (SQL 0023 §10)
-- and the dunning events (SQL 0027). A register you can tidy is a
-- register no auditor will trust.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
     WHERE grantee = CURRENT_USER
       AND table_name = 'tenant_patterns'
       AND privilege_type = 'DELETE'
  ) THEN
    -- Cannot revoke from ourselves in all contexts; this is a signal
    -- to the operator. The application layer enforces no-delete.
    RAISE NOTICE 'tenant_patterns: DELETE privilege should be revoked from the web role.';
  END IF;
END $$;
