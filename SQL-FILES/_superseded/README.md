# Superseded — do not run

These three files created four tenant-scoped tables with **no row-level
security**: no `ENABLE`, no `FORCE`, no policy. In Ordence, RLS *is* the
tenant boundary — every policy reads `app.current_tenant_id`, which
`withTenant()` pins. A `tenant_id` column with no policy behind it means
every tenant can read every other tenant's rows.

They were also numbered 0062 / 0072 / 0076 when the highest real migration
was 0045, leaving permanent gaps that make "run these in order" meaningless.

**Replaced by:** `../0046_deployment_flows_governance.sql`, which creates the
same four tables plus the missing `ui_governance_checks` tracker, with the
policy shape every other table here uses:

    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id())

If any of these three were already run against a database, run 0046 — it is
idempotent (`CREATE TABLE IF NOT EXISTS`, guarded policy creation) and will
add the missing RLS to the existing tables rather than duplicating them.
