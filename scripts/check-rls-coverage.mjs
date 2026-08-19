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
 * The read boundary is checked SEPARATELY, by PLATFORM_READ_REFUSED
 * below. This paragraph used to assert that every table here still had
 * a USING clause denying cross-tenant reads. That was false for three of
 * them and had been since 0079, and the old read test could not have
 * caught it: it asked whether the USING clause still mentioned
 * `app_current_tenant_id`, which `... OR app_platform_scope()` still
 * satisfies. This list only permits the
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
  /**
   * ⚠️ `email_suppressions` IS NOT HERE, AND IT USED TO FAIL THIS GATE.
   * Its WITH CHECK is
   *
   *     tenant_id = app_current_tenant_id()
   *     OR (tenant_id IS NULL AND app_platform_scope())
   *
   * The marker is CONJOINED with `tenant_id IS NULL`, so platform scope
   * can write only a GLOBAL suppression row , never another tenant's.
   * That is a different act from a cross-tenant write and it needs no
   * opt-in. `isGlobalWriteOnly()` below recognises the idiom, so the safe
   * shape stops being reported and the unsafe shape stays reported.
   */
]);

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE READ SIDE, WHICH THIS GATE DID NOT USED TO CHECK AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 The docstring above `OPT_IN_PLATFORM_WRITE` claimed "The read
 * boundary is UNTOUCHED: every table here still has a USING clause that
 * denies cross-tenant reads." That was false, and the old read test could
 * not have seen it: it asked whether the USING clause still mentioned
 * `app_current_tenant_id`, which `... OR app_platform_scope()` still
 * satisfies.
 *
 * ⚠️ AND AN ALLOWLIST IS THE WRONG SHAPE HERE. 114 of 303 tenant tables
 * carry the read marker. That is not a leak , it is the deliberate
 * "platform read scope" 0014 Section 6 introduces for the tables holding
 * the COMMERCIAL RELATIONSHIP, and roughly a dozen module files have
 * extended it since. Requiring 114 written justifications would produce
 * 114 copied sentences and one gate nobody can adopt.
 *
 * ⭐ SO THIS ENCODES THE REFUSALS INSTEAD. Two files state, in prose,
 * that specific tables must NEVER acquire the read marker. Those
 * sentences are the decision. Everything below turns them into a
 * predicate that runs on every push, which is the only property they were
 * missing , 0022 shipped a check for its own four tables and it lives in
 * 0022, and nobody re-runs an old file's verification section.
 */
const PLATFORM_READ_REFUSED = new Map([
  /* ── 0022_phase29_admin_console.sql, header and Check 12 ───────────
   * "IT DOES NOT WIDEN `app_platform_scope()`. Not by one table."
   * "WITH the marker: one query reads every customer's security events."
   * "Check 12 below FAILS LOUDLY if any of the three ever acquires the
   *  marker."
   *
   * 🔴 `security_events` IS THE ONE THAT DID. 0079_rls_opt_in_and_
   * telemetry.sql added `OR app_platform_scope()` to its USING clause,
   * 57 files later, while fixing a genuine and unrelated WRITE bug , the
   * policy had been DISCARDING every attributed row, so security events
   * naming a workspace went on the floor. That fix needed the WITH CHECK
   * branch. It took the USING branch in the same statement, never
   * mentions 0022, and `usage_counters`, `usage_levels` and `audit_logs`
   * came through clean, so the refusal held for three tables out of four.
   *
   * ⚠️ IT IS DELIBERATELY LEFT IN PLACE RATHER THAN REVERTED, because
   * `server/security/anomalies.ts` now depends on it: its platform-wide
   * sweep is the only thing that ever looks at the unattributed perimeter
   * rows, and its own comment says an anomaly detector that silently sees
   * zero events is the most dangerous shape of broken there is. Reverting
   * it here, in a gate, would trade a recorded widening for a silent
   * blindness. It is recorded as `ACCEPTED` so the next reader finds the
   * decision instead of rediscovering the contradiction.
   */
  ["usage_counters",  { by: "0022", why: "one query would read every customer's metered usage" }],
  ["usage_levels",    { by: "0022", why: "one query would read every customer's metered usage" }],
  ["audit_logs",      { by: "0022", why: "one query would read every customer's audit trail" }],
  ["security_events", {
    by: "0022",
    why: "one query would read every customer's security events",
    accepted: "0079 widened it to fix a write bug that was discarding every attributed row. server/security/anomalies.ts now depends on the cross-tenant read for its perimeter sweep. Recorded rather than reverted; see the note above.",
  }],

  /* ── 0014_phase17_platform.sql, Section 6 ──────────────────────────
   * "DELIBERATELY NOT ADDED to the tables holding CUSTOMER CONTENT …
   *  These hold data about the customer's OWN customers , third parties
   *  who never had a relationship with us and whose data we hold as a
   *  PROCESSOR. Reading it for our own convenience is processing with no
   *  lawful basis; 'it made the ticket faster' is not a purpose."
   *
   * "If a future phase adds a platform clause to any of them, that is a
   *  change to the data-protection posture of the product and it belongs
   *  in a review."
   *
   * ⭐ THIS GATE IS THAT REVIEW. All ten are still clean today.
   */
  ["contacts",              { by: "0014", why: "customer content, held as a processor" }],
  ["companies",             { by: "0014", why: "customer content, held as a processor" }],
  ["deals",                 { by: "0014", why: "customer content, held as a processor" }],
  ["custom_object_records", { by: "0014", why: "customer content, held as a processor" }],
  ["assets",                { by: "0014", why: "customer content, held as a processor" }],
  ["contracts",             { by: "0014", why: "customer content, held as a processor" }],
  ["contract_versions",     { by: "0014", why: "customer content, held as a processor" }],
  ["journal_entries",       { by: "0014", why: "the customer's general ledger" }],
  ["transactions",          { by: "0014", why: "the customer's general ledger" }],
  ["ledgers",               { by: "0014", why: "the customer's general ledger" }],
]);

/**
 * Is the platform marker in this WITH CHECK confined to writing GLOBAL
 * (null-tenant) rows?
 *
 * ⚠️ TEXT MATCHING, AND IT IS DELIBERATELY STRICT. It recognises exactly
 * the one idiom the codebase uses, normalised for whitespace and for the
 * parentheses PostgreSQL adds when it prints a policy back:
 *
 *     (tenant_id IS NULL AND app_platform_scope())
 *
 * Anything else , a bare `OR app_platform_scope()`, a disjunction, a
 * rewritten predicate , is NOT recognised and is reported. A matcher that
 * tried to be clever here would eventually accept a cross-tenant write.
 */
function isGlobalWriteOnly(withCheck) {
  if (!withCheck) return false;
  const flat = withCheck.replace(/[()\s]+/g, " ").toLowerCase().trim();
  const occurrences = (flat.match(/app_platform_scope/g) ?? []).length;
  if (occurrences !== 1) return false;
  return flat.includes("tenant_id is null and app_platform_scope");
}

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
      COALESCE(bool_or(p.qual::text LIKE '%app_platform_scope%'), false)
                                                       AS marker_read,
      string_agg(COALESCE(p.with_check::text, ''), ' | ')
                                                       AS with_check_text,
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
    if (
      t.marker_write &&
      !OPT_IN_PLATFORM_WRITE.has(t.table_name) &&
      !isGlobalWriteOnly(t.with_check_text)
    ) {
      fail(`${t.table_name} allows app_platform_scope() in WITH CHECK — that permits a cross-tenant WRITE. Platform scope belongs in USING only, unless it is conjoined with tenant_id IS NULL (a global row), in which case say so in the policy.`);
    }

    /**
     * ⭐ THE READ SIDE. See PLATFORM_READ_REFUSED.
     *
     * A platform-scope read is not automatically wrong , 114 tables have
     * one by design. It is wrong on a table somebody wrote down that it
     * must never have one, and that is all this refuses.
     */
    const refusal = PLATFORM_READ_REFUSED.get(t.table_name);
    if (t.marker_read && refusal && !refusal.accepted) {
      fail(
        `${t.table_name} allows app_platform_scope() in its USING clause, and ${refusal.by} refused exactly that: ${refusal.why}. ` +
          `One query on a platform-scoped connection now reads every tenant's rows from this table. ` +
          `If this widening is deliberate, record it in PLATFORM_READ_REFUSED with an \`accepted\` note saying who depends on it; do not delete the entry.`,
      );
    }

    /**
     * ⚠️ AND THE OTHER DIRECTION. An `accepted` widening is a recorded
     * dependency. `security_events` losing the marker again would leave
     * the anomaly detector's perimeter sweep reading zero rows on a
     * platform-scoped connection , silently, and quiet reads as safe.
     */
    if (refusal && refusal.accepted && !t.marker_read) {
      fail(
        `${t.table_name} carries an ACCEPTED platform-read widening in PLATFORM_READ_REFUSED, but its USING clause no longer has app_platform_scope(). ` +
          `Whatever depended on the cross-tenant read now sees zero rows without erroring. If the widening was deliberately reverted, remove the accepted note and say why.`,
      );
    }
  }

  const checked = rows.filter((t) => !NOT_TENANT_SCOPED.has(t.table_name)).length;
  const readMarker = rows.filter(
    (t) => !NOT_TENANT_SCOPED.has(t.table_name) && t.marker_read,
  ).length;

  /**
   * ⚠️ REPORTED EVERY RUN, PASS OR FAIL. This number is the size of the
   * platform read scope, and it should be looked at occasionally rather
   * than only when something fails. It grew from 0014's handful to 114
   * without anybody stating a total.
   */
  console.log(
    `   platform read scope: ${readMarker}/${checked} tenant tables carry ` +
      `app_platform_scope() in USING · ${PLATFORM_READ_REFUSED.size} tables are ` +
      `on the refusal list`,
  );

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
