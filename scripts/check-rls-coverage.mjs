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
                                                       AS cross_tenant_write
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
    if (t.cross_tenant_write) {
      fail(`${t.table_name} allows app_platform_scope() in WITH CHECK — that permits a cross-tenant WRITE. Platform scope belongs in USING only.`);
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
