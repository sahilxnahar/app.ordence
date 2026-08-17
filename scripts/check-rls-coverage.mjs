#!/usr/bin/env node
/**
 * Ordence — Exhaustive RLS coverage gate
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Four tenant-scoped tables — `deployment_releases`, `deployment_backups`,
 * `security_batches`, `flow_submissions` — were created with a
 * `tenant_id` column and NO row-level security. No ENABLE, no FORCE, no
 * policy. Every tenant could read every other tenant's rows.
 *
 * ⚠️ THE EXISTING CI STEP WOULD NOT HAVE CAUGHT IT. It asserts a FLOOR:
 *
 *     if [ "$COUNT" -lt 100 ]; then exit 1; fi
 *
 * Adding four unprotected tables to a database with 160 protected ones
 * leaves the count at 160. The floor passes. A floor measures how much
 * was done right; it cannot see what was done wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECKS — EXHAUSTIVELY, NOT STATISTICALLY
 * ══════════════════════════════════════════════════════════════════════
 * For EVERY table in `public` carrying a `tenant_id` column:
 *
 *   1. `relrowsecurity`      — RLS is enabled.
 *   2. `relforcerowsecurity` — and forced. ENABLE alone does not apply
 *      to the table OWNER, and the application connects as the owner on
 *      Neon, so ENABLE without FORCE is decoration.
 *   3. A policy whose USING clause references `app_current_tenant_id`.
 *   4. Platform scope, if present, appears in USING and NEVER in
 *      WITH CHECK — read across tenants for support, never write.
 *      One narrow exception: the seven opt-in platform-evidence tables
 *      from `0079_rls_opt_in_and_telemetry.sql` write through
 *      `app_platform_scope()` by design (see OPT_IN_PLATFORM_WRITE).
 *
 * Zero exceptions, zero thresholds. One unprotected table fails the run.
 *
 * Requires a database. In CI it runs against the service container after
 * the SQL has been applied. Locally: DATABASE_URL=... node this.
 */

import { Pool } from "pg";

const URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!URL) {
  console.error("::error::DATABASE_URL is not set — cannot verify RLS coverage.");
  console.error("This check requires a live database. It is not optional in CI:");
  console.error("skipping it is how four unprotected tables shipped.");
  process.exit(1);
}

/**
 * ⚠️ TABLES LEGITIMATELY WITHOUT TENANT SCOPE.
 *
 * `tenants` is the tenant list itself; `plans` is the global price list.
 * Both are read across tenants by design and have their own policies.
 * Named explicitly so that adding to this list is a visible decision.
 */
const NOT_TENANT_SCOPED = new Set(["tenants", "plans"]);

/**
 * ⚠️ PLATFORM-EVIDENCE TABLES THAT WRITE THROUGH THE OPT-IN MARKER.
 *
 * `0079_rls_opt_in_and_telemetry.sql` moved these seven tables' WITH CHECK
 * from the blanket `app_current_tenant_id() IS NULL` to
 * `app_platform_scope()` — the opt-in design: anything written into a
 * tenant's workspace on the platform's own behalf must first declare
 * platform scope inside a transaction, with a reason recorded at the
 * service layer. `0089_hardening_login_lockouts.sql` adds `login_lockouts`,
 * a platform-security table, to the same design. A plain HTTP session with no tenant set could otherwise
 * write platform evidence silently (a worker, a cron, a forgotten
 * `withTenant`).
 *
 * The read boundary is UNTOUCHED: every table here still has a USING
 * clause that denies cross-tenant reads. This list only permits the
 * marker on the WRITE side. Name the tables explicitly so that adding
 * to this list is a visible decision.
 */
const OPT_IN_PLATFORM_WRITE = new Set([
  /**
   * `0091_slug_authority.sql` adds `tenant_slug_history`, the ninth entry.
   *
   * ⚠️ WHY IT NEEDS THE MARKER RATHER THAN AN ORDINARY TENANT WRITE POLICY.
   * A slug rename is a PLATFORM act: an operator performs it, inside
   * `withPlatformScope(reason, cb)`, on behalf of a tenant. The row it writes
   * is the EVIDENCE of what the platform did, and a tenant that could write
   * its own slug history could rewrite that evidence. The read boundary is
   * untouched — the USING clause still names `app_current_tenant_id()`, so a
   * tenant sees its own history and nobody else's.
   *
   * 🔴 The rows are also the 365-day retention record for a released
   * hostname. Deleting one hands a live hostname, still sitting in bookmarks
   * and in the CT log, to a different company. `0091` grants no DELETE on
   * this table for exactly that reason.
   */
  "tenant_slug_history",
  "login_lockouts",
  "error_events",
  "platform_entitlement_history",
  "platform_impersonation_sessions",
  "platform_tenant_flags",
  "security_events",
  "tenant_health_events",
  "web_vital_events",
]);

const pool = new Pool({ connectionString: URL });
let failures = 0;
const fail = (m) => {
  console.error(`::error::${m}`);
  failures++;
};

try {
  const { rows } = await pool.query(`
    SELECT
      c.relname                                        AS table_name,
      c.relrowsecurity                                 AS rls_enabled,
      c.relforcerowsecurity                            AS rls_forced,
      COALESCE(bool_or(p.qual::text LIKE '%app_current_tenant_id%'), false)
                                                       AS has_tenant_policy,
      COALESCE(bool_or(p.with_check::text LIKE '%app_platform_scope%'), false)
                                                       AS marker_write,
      COALESCE(
        bool_or(
          (p.qual::text LIKE '%app_current_tenant_id%')
          OR (p.qual::text LIKE '%tenant_id%')
        ),
        false
      )                                              AS has_tenant_read_policy
    FROM pg_class c
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid
                        AND a.attname = 'tenant_id'
                        AND a.attnum > 0
                        AND NOT a.attisdropped
    LEFT JOIN pg_policies p ON p.schemaname = 'public'
                           AND p.tablename = c.relname
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
    ORDER BY c.relname
  `);

  if (rows.length === 0) {
    fail(
      "No tables with a tenant_id column were found. The schema is not " +
        "applied, so this check would have passed vacuously — which is worse " +
        "than failing.",
    );
  }

  for (const t of rows) {
    if (NOT_TENANT_SCOPED.has(t.table_name)) continue;

    if (!t.rls_enabled) {
      fail(`${t.table_name} has a tenant_id column but ROW LEVEL SECURITY IS NOT ENABLED — every tenant can read every other tenant's rows.`);
      continue;
    }
    if (!t.rls_forced) {
      fail(`${t.table_name} has RLS enabled but NOT FORCED. The app connects as the table owner, and RLS does not apply to the owner without FORCE.`);
    }
    if (!t.has_tenant_policy) {
      fail(`${t.table_name} has RLS enabled but no policy referencing app_current_tenant_id() — RLS with no policy denies everything, which fails closed but breaks the table.`);
    }
    if (t.marker_write && !OPT_IN_PLATFORM_WRITE.has(t.table_name)) {
      fail(`${t.table_name} allows app_platform_scope() in WITH CHECK — that permits a cross-tenant WRITE. Platform scope belongs in USING only.`);
    }
    if (OPT_IN_PLATFORM_WRITE.has(t.table_name)) {
      // The opt-in marker is only legitimate while the READ boundary
      // still holds. If the USING clause lost its tenant reference,
      // the table silently became a cross-tenant window in both
      // directions.
      if (!t.has_tenant_read_policy) {
        fail(`${t.table_name} is an opt-in platform-write table but its USING clause no longer references the tenant — a cross-tenant READ hole.`);
      }
      if (!t.marker_write) {
        fail(
          `${t.table_name} is a documented opt-in platform-write table, but its WITH CHECK no longer requires the platform-scope marker — the marker can be removed by accident just as easily as a policy. If the marker was deliberately removed, remove the table from OPT_IN_PLATFORM_WRITE and say why.`,
        );
      }
    }
  }

  const checked = rows.filter((t) => !NOT_TENANT_SCOPED.has(t.table_name)).length;

  if (failures > 0) {
    console.error(`\n❌ RLS coverage FAILED — ${failures} problem(s) across ${checked} tenant tables.\n`);
    process.exit(1);
  }

  console.log(`✅ RLS coverage complete — all ${checked} tenant-scoped tables enabled, forced and policied.`);
} catch (err) {
  console.error(`::error::RLS coverage check could not run: ${err instanceof Error ? err.message : err}`);
  // ⚠️ FAILS CLOSED, unlike the billing gate. A check that cannot run is
  // not a check that passed — that confusion is exactly what let the
  // `.next/static` leak scan report ✅ on a directory it never read.
  process.exit(1);
} finally {
  await pool.end();
}
