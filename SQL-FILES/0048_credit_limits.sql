-- 0048_credit_limits.sql
-- Credit limits per customer + approval limits per role/scope.
-- GRP go-live blocker.
--
-- SEMANTICS — do not change these without reading lib/credit/exposure.ts first
--   credit_limit_minor NULL  =  NO LIMIT SET (unlimited). This is the default
--                                state and it blocks NO order.
--   credit_limit_minor 0     =  BLOCKED entirely. Every order routes to
--                                approval regardless of amount.
--   max_value_minor NULL on approval_limits =  UNLIMITED for that scope.
--   Confusing NULL with zero is how a system stops a customer's entire trade
--   overnight. The NULL-is-unlimited rule is the rule that keeps credit limits
--   from being a surprise weapon.

-- =====================================================================
--  TABLE: customer_credit_profiles
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_credit_profiles (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- NULL = unlimited. 0 = blocked. Do not conflate them.
    credit_limit_minor  bigint,
    payment_terms_days  integer,
    on_hold             boolean     NOT NULL DEFAULT false,
    hold_reason         text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT customer_credit_profiles_tenant_company_key UNIQUE (tenant_id, company_id)
);

-- =====================================================================
--  TABLE: approval_limits
--  Per-role cap on the value a user may approve in a given scope.
--  🔴 SEE THE NOTE BELOW ON WHY `role` IS TEXT AND NOT A FOREIGN KEY.
--  NULL max_value_minor = unlimited for that scope.
-- =====================================================================
--  🔴 `role` IS THE SystemRole ENUM VALUE AS TEXT, NOT A FK TO `roles`.
--
--  The first draft of this table had `role_id uuid REFERENCES roles(id)`.
--  It would have been dead on arrival. Nothing in this codebase reads the
--  `roles` table — permissions resolve from `users.role`, which is the
--  `system_role` ENUM, through ROLE_TEMPLATES in db/schema/auth.ts. An
--  approval limit keyed on `roles.id` could never be matched to a session,
--  so every configured limit would grant nobody anything, and the settings
--  screen would show a fully configured approval ladder.
--
--  ⚠️ NOT DECLARED AS THE `system_role` ENUM TYPE EITHER, and for the same
--  reason `scope` is a varchar: adding a role would then be a type
--  migration. `permission_denials.actor_role` already stores the role this
--  way (varchar(60)); this matches it.
CREATE TABLE IF NOT EXISTS approval_limits (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role              varchar(60) NOT NULL,
    scope             varchar(40) NOT NULL,
    -- 'sales_order' | 'discount_pct' | 'purchase_order' | 'write_off'
    -- Stored as varchar(40) rather than an enum so scopes can be extended
    -- without a type migration.
    max_value_minor   bigint,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT approval_limits_tenant_role_scope_key UNIQUE (tenant_id, role, scope)
);

-- =====================================================================
--  INDEXES
--  The UNIQUE constraints already create the most-used indexes. Add only
--  what is genuinely needed beyond those.
-- =====================================================================
CREATE INDEX IF NOT EXISTS customer_credit_profiles_tenant_idx
    ON customer_credit_profiles (tenant_id);

CREATE INDEX IF NOT EXISTS approval_limits_tenant_role_idx
    ON approval_limits (tenant_id, role);

-- =====================================================================
--  ROW LEVEL SECURITY
--
--  ⚠️ THE PREDICATE IS `app_current_tenant_id()`, NOT A RAW
--     `current_setting(...)`.
--
--  The helper is defined in 0001_rls_and_audit_guard.sql as exactly that
--  expression, STABLE, and it is what 359 other policy clauses in this
--  directory use. Inlining the raw call works today and is one more place
--  to edit the day the tenant key changes.
--
--  ⚠️ `OR app_platform_scope()` BELONGS IN `USING` AND NEVER IN
--     `WITH CHECK`.
--
--  USING governs what a row-level policy lets you SEE. Platform staff
--  need to see a workspace's data to support it — that is what the
--  console at admin.ordence.com does for a living, and a table without
--  this clause is invisible to it.
--
--  WITH CHECK governs what you may WRITE. Platform staff must never be
--  able to write into a customer's workspace, because an action nobody
--  in that workspace took, appearing in their data, is indistinguishable
--  from a breach when they go looking.
--
--  Both clauses are required. USING alone lets a row be written into
--  another tenant even though it cannot be read back.
-- =====================================================================

-- customer_credit_profiles
ALTER TABLE customer_credit_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_credit_profiles_tenant_isolation ON public.customer_credit_profiles;
CREATE POLICY customer_credit_profiles_tenant_isolation ON public.customer_credit_profiles
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- approval_limits
ALTER TABLE approval_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_limits_tenant_isolation ON public.approval_limits;
CREATE POLICY approval_limits_tenant_isolation ON public.approval_limits
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- =====================================================================
--  GRANTS TO ordence_app
--
--  A table nobody granted is a 42501 in production — this project shipped
--  exactly that bug with three views (v_stock_over_committed,
--  v_boq_billing_position, v_mcp_activity) and only found it days later.
--  Grant in the same file as the table, every time.
--
--  ⚠️ DELETE IS GRANTED, AND THE "YOU MAY NOT DELETE A CREDIT PROFILE"
--     RULE LIVES IN THE ACTION LAYER, NOT HERE.
--
--  Withholding the privilege enforces the same rule, but the refusal it
--  produces is `permission denied for table customer_credit_profiles` —
--  a sentence written for a DBA, surfaced to a salesperson. Every other
--  refusal in this codebase is a sentence a person can act on, and the
--  privilege grid is the wrong place to hold a product rule.
--
--  It also matches the convention: `GRANT SELECT, INSERT, UPDATE, DELETE
--  … TO ordence_app` is what the other numbered migrations issue.
-- =====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_credit_profiles TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_limits          TO ordence_app;
