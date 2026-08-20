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

/* ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WAVE 15 (Track C) — WHAT WAS ADDED, AND WHY EACH PART EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Everything above this line reads the CATALOG. That was the right first
 * move and it is not enough, for a reason this file could not see about
 * itself:
 *
 * 🔴 A CATALOG CHECK PASSES ON A DATABASE WHERE EVERY POLICY IS SKIPPED.
 * `relforcerowsecurity = true` means the table's OWNER is subject to row
 * security. It does not mean the CONNECTING ROLE is. A role holding
 * `rolbypassrls` — or `rolsuper` — skips every policy on every table, and
 * FORCE does not change that. Measured on PostgreSQL 16.13, on a table
 * owned by a NON-superuser role with BYPASSRLS, RLS enabled, FORCED, and
 * a correct tenant policy:
 *
 *     as the BYPASSRLS owner, tenant = 'A'  →  2 rows: A's and B's
 *     as a NOBYPASSRLS role,  tenant = 'A'  →  1 row:  A's
 *
 * `SQL-FILES/WHO-DOES-THE-APP-CONNECT-AS-neon-safe.sql` and
 * `SQL-FILES/CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql` both record
 * `neondb_owner has rolbypassrls = true` on this project. If the
 * application connects as that role, all 303 forced tables are decoration
 * and this gate said ✅ every time.
 *
 * So four parts now, in increasing order of how much they prove:
 *
 *   A. the catalog          (above — unchanged)
 *   B. the ROLE posture     does row security apply to anybody?
 *   C. drift + contract     is anything unprotected or newly changed?
 *   D. THE CROSS-TENANT PROBE  two tenants, a real row in every tenant
 *                              table, and a real attempt to read across.
 *
 * ⚠️ D IS THE ONLY ONE THAT PROVES ISOLATION RATHER THAN DESCRIBING IT,
 * and it is exhaustive on purpose. `tests/security/rls-isolation.test.ts`
 * is excellent and seeds ELEVEN tables. The four tables that shipped with
 * no RLS at all were not among any hand-picked eleven, and they never
 * would be — that is what "verified by a sample" means here.
 * ══════════════════════════════════════════════════════════════════════ */

const pool = new Pool({ connectionString: URL });
let failures = 0;
const fail = (m) => {
  console.error(`::error::${m}`);
  failures++;
};
const note = (m) => console.log(`   ${m}`);

/**
 * ⚠️ EVERY PART BELOW EITHER RUNS OR FAILS. None of them may skip.
 * `scripts/run-gates.mjs` reserves exit 78 for a whole gate that found no
 * configuration; a PART of a gate quietly doing nothing is invisible even
 * to that, and "3 of 4 parts ran" is not a state anybody would notice.
 */
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

  /* ══════════════════════════════════════════════════════════════════
   * PART B — DOES ROW SECURITY APPLY TO ANYBODY?
   * ══════════════════════════════════════════════════════════════════ */

  console.log("\n── B · role posture ──");

  const posture = (
    await pool.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin,
             (r.rolname = current_user) AS is_me,
             EXISTS (
               SELECT 1 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                                    AND a.attnum > 0 AND NOT a.attisdropped
                WHERE n.nspname = 'public' AND c.relkind = 'r'
                  AND has_table_privilege(r.oid, c.oid, 'SELECT')
             ) AS holds_tenant_read
        FROM pg_roles r
       ORDER BY r.rolname
    `)
  ).rows;

  const me = posture.find((r) => r.is_me);
  note(
    `connected as ${me?.rolname ?? "?"} · superuser=${me?.rolsuper} · bypassrls=${me?.rolbypassrls}`,
  );

  /**
   * 🔴 RULE 1 — A NON-SUPERUSER WITH BYPASSRLS IS THE ANOMALY.
   *
   * A superuser bypassing row security is how PostgreSQL works and is not
   * news; CI runs as `postgres` and always will. `rolbypassrls` on a role
   * that is NOT a superuser is a deliberate, separately-granted attribute
   * whose only effect is to exempt that role from every policy — and it is
   * exactly what `neondb_owner` carries on this project.
   *
   * ⚠️ THIS RULE IS GREEN IN CI AND WOULD BE RED ON NEON, AND THAT IS THE
   * POINT RATHER THAN A LIMITATION. This gate has never been pointed at a
   * Neon branch. `SELECT * FROM isolation_posture()` (0137) is the same
   * question in a form you can paste into the console, and it should be
   * run there.
   */
  for (const r of posture) {
    if (r.rolcanlogin && r.rolbypassrls && !r.rolsuper && r.holds_tenant_read) {
      fail(
        `role ${r.rolname} is NOT a superuser, holds BYPASSRLS, and can SELECT from tenant tables. ` +
          `Row security does not apply to it and FORCE ROW LEVEL SECURITY does not change that: ` +
          `every one of the ${checked} policies above is skipped for this role. If DATABASE_URL names ` +
          `it, this product has no database-level tenant isolation at all. BYPASSRLS is granted, not ` +
          `inherited — take it off with ALTER ROLE ${r.rolname} NOBYPASSRLS, or point the application ` +
          `at a role that never had it.`,
      );
    }
  }

  /**
   * 🔴 RULE 2 — THE APPLICATION ROLE, BY NAME.
   *
   * `scripts/sealed-grants.json` seals BYPASSRLS and SUPERUSER against
   * `ordence_app` — and `check-sealed-grants.mjs` is STATIC: it greps .sql
   * for `GRANT` statements and cannot see a role attribute set by hand in
   * a console, which is the only way this one is ever set. Two seals in
   * that file have therefore never been checked by anything. This is where
   * they get checked.
   */
  const app = posture.find((r) => r.rolname === "ordence_app");
  if (app && (app.rolsuper || app.rolbypassrls)) {
    fail(
      `ordence_app has ${app.rolsuper ? "SUPERUSER" : ""}${app.rolsuper && app.rolbypassrls ? " and " : ""}${app.rolbypassrls ? "BYPASSRLS" : ""}. ` +
        `scripts/sealed-grants.json seals both ("app-is-never-superuser", "app-is-never-superuser-attr"): ` +
        `"Row-level security is the ONLY tenant isolation in this product. A role with BYPASSRLS sees every ` +
        `tenant's data on every query and nothing in the application layer would notice."`,
    );
  } else if (!app) {
    note("ordence_app does not exist on this database — the two role-attribute seals cannot be checked here.");
  } else {
    note("ordence_app: NOSUPERUSER, NOBYPASSRLS — row security applies to it.");
  }

  const exempt = posture.filter((r) => r.rolcanlogin && (r.rolsuper || r.rolbypassrls));
  note(
    `${exempt.length} login role(s) exempt from row security: ` +
      exempt.map((r) => `${r.rolname}(${r.rolsuper ? "superuser" : "bypassrls"})`).join(", "),
  );

  /* ══════════════════════════════════════════════════════════════════
   * PART C — DRIFT AND THE SCHEMA CONTRACT
   * ══════════════════════════════════════════════════════════════════ */

  console.log("\n── C · drift and schema contract ──");

  /**
   * ⚠️ A MISSING FUNCTION IS A FAILURE, NOT A SKIP. If 0140 has not been
   * applied, this gate stops checking four properties and would otherwise
   * say nothing about it — which is how a control turns off silently.
   */
  const hasFn = async (name) =>
    (
      await pool.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [name],
      )
    ).rowCount > 0;

  if (!(await hasFn("tenant_table_drift"))) {
    fail(
      "tenant_table_drift() does not exist. SQL-FILES/0140_tenant_table_drift_detector.sql " +
        "has not been applied, so nothing checks that a NEW table arrives with a policy, FORCE, " +
        "a change_log trigger and an impersonation guard.",
    );
  } else {
    const drift = (await pool.query(`SELECT * FROM tenant_table_drift()`)).rows;
    for (const d of drift) {
      fail(`${d.table_name} is missing ${d.property} — ${d.detail}`);
    }
    note(
      drift.length === 0
        ? `drift: 0 findings across ${checked} tenant tables (policy, FORCE, change_log trigger, impersonation guard)`
        : `drift: ${drift.length} finding(s)`,
    );
  }

  if (!(await hasFn("diff_schema_contract"))) {
    fail(
      "diff_schema_contract() does not exist. SQL-FILES/0139_schema_contract_snapshot.sql " +
        "has not been applied, so a `drizzle-kit push` that removed every policy would leave no trace " +
        "this gate could compare against.",
    );
  } else {
    /**
     * ⚠️ THE SNAPSHOT LIVES IN THE DATABASE, SO A DATABASE CI BUILT FROM
     * SCRATCH CARRIES THE ONE 0139 TOOK ON ITS WAY UP. That makes this a
     * check that the SQL sequence produces a self-consistent shape, not a
     * check against production — which is the honest limit of it, and it
     * is stated here rather than implied. Diffing a CI database against a
     * committed production fingerprint is the next step and it needs a
     * file outside this track's ownership; see PATCH-REQUEST-C.md.
     */
    const diff = (await pool.query(`SELECT * FROM diff_schema_contract()`)).rows;

    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 WAVE 17 — `REMOVED` AND `CHANGED` FAIL. `ADDED` IS REPORTED.
     * ══════════════════════════════════════════════════════════════════
     * Wave 15 failed on any difference at all, and the argument was that
     * an unrecorded change to the isolation boundary is exactly what this
     * control is for. That argument rested on one assumption:
     * `0142_capture_schema_contract.sql` is the LAST file in the
     * sequence, so the snapshot is always current.
     *
     * ⚠️ THAT ASSUMPTION DIED THE MOMENT THE WAVE WAS ASSEMBLED, AND IT
     * CANNOT BE REVIVED. Six tracks numbered above 0142; measured on the
     * assembled tree, `diff_schema_contract()` returned **25 rows, every
     * one of them ADDED** — five functions and a table from Track E's tax
     * work, six triggers, three from a `CREATE EXTENSION`. Nothing was
     * wrong. "0142 must be last" is not a property any track can own,
     * because the next wave always numbers higher.
     *
     * ⭐ SO THE RULE IS SHAPED TO THE THING IT DETECTS INSTEAD.
     * `drizzle-kit push` REMOVES: 303 tables lose `rls=true`, 314 policies
     * disappear, every trigger goes. It has never added anything. A new
     * migration ADDS. The two are opposite signatures and the check can
     * simply tell them apart:
     *
     *     REMOVED   a policy, trigger or function that was there is gone.
     *               This is the push signature. FAIL.
     *     CHANGED   a policy's USING text is different, or a trigger now
     *               executes a different function. A rewritten isolation
     *               boundary nobody recorded. FAIL.
     *     ADDED     forward progress. Printed, counted, not fatal.
     *
     * ⚠️ AND THE WEAKENING IS SMALLER THAN IT LOOKS. An added table with
     * no row security is caught three other ways in this same run — the
     * catalog check in Part A, `tenant_table_drift()` in this section, and
     * the cross-tenant probe in Part D, which reads the row as the wrong
     * tenant and says so. Measured against a deliberately unprotected
     * table: seven findings, of which the contract was one.
     */
    const removedOrChanged = diff.filter((d) => d.change !== "ADDED");
    const added = diff.filter((d) => d.change === "ADDED");

    for (const d of removedOrChanged) {
      fail(
        `schema contract ${d.change}: ${d.kind} ${d.ident}` +
          (d.change === "CHANGED" ? ` (was "${d.was}", is now "${d.is_now}")` : "") +
          `. A REMOVED policy, trigger or function is what \`drizzle-kit push\` looks like — it ` +
          `takes away, it never adds. If this change was intended, record it: ` +
          `SELECT * FROM capture_schema_contract('why');`,
      );
    }

    if (added.length > 0) {
      /**
       * ⚠️ PRINTED IN FULL, NOT SUMMARISED TO A NUMBER. "12 objects were
       * added" is a line people skim. The list is what lets somebody
       * notice that one of the twelve is a policy on a table they know
       * nothing about.
       */
      note(
        `${added.length} object(s) ADDED since the last capture — expected after a new ` +
          `migration, and not fatal. Capture when the batch lands: ` +
          `SELECT * FROM capture_schema_contract('what this batch changed');`,
      );
      for (const d of added) console.log(`        + ${d.kind} ${d.ident}`);
    }

    const fp = (await pool.query(`SELECT schema_contract_fingerprint() AS f`)).rows[0].f;
    note(
      `schema contract: ${removedOrChanged.length} removed/changed · ${added.length} added · ` +
        `fingerprint ${fp.slice(0, 16)}…`,
    );
  }

  /* ══════════════════════════════════════════════════════════════════
   * PART D — THE CROSS-TENANT PROBE
   * ══════════════════════════════════════════════════════════════════
   * ⭐ EVERY TENANT TABLE. NOT A SAMPLE. The gate this file replaced
   * asserted `count(*) >= 100`; the suite that replaced THAT seeds eleven
   * tables by hand. Neither could have found `deployment_releases`,
   * `deployment_backups`, `security_batches` or `flow_submissions`,
   * because an unprotected table is by definition one nobody thought
   * about, and a hand-written list contains only tables somebody thought
   * about.
   *
   * HOW IT WORKS, AND WHY EACH STEP IS THE WAY IT IS:
   *
   *   1. ONE TRANSACTION, ROLLED BACK. Nothing survives. A probe that
   *      leaves rows behind is a probe that eventually leaves a row in
   *      production; `tests/security/dynamic-objects.test.ts` once left a
   *      real table called `leak_probe` in a database for a week.
   *
   *   2. `session_replication_role = replica` while seeding. That
   *      disables user triggers AND foreign-key checks, so a row can be
   *      inserted into a table whose parents are empty. Without it this
   *      probe could only cover tables with no FKs, which is a sample
   *      again, chosen by schema shape instead of by hand.
   *
   *   3. THE ROWS ARE INSERTED BY THE SUPERUSER AND READ BY A ROLE THAT
   *      ROW SECURITY APPLIES TO. Reading them back as the superuser
   *      would prove nothing at all — that is the mistake the whole
   *      security suite is built to avoid, and it is one `SET ROLE` away.
   *
   *   4. BOTH DIRECTIONS ARE ASSERTED. Tenant A must SEE its own row and
   *      tenant B must NOT. Asserting only "B sees nothing" passes
   *      trivially on a table where the seed silently failed, on an empty
   *      table, and on a table whose policy denies everybody — three
   *      states that look identical from one side.
   */

  console.log("\n── D · cross-tenant probe, every tenant table ──");

  const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";

  const client = await pool.connect();
  const unseeded = [];
  const unreadable = [];
  let probed = 0;
  let leaked = 0;
  let invisible = 0;
  let platformOnly = 0;

  try {
    await client.query("BEGIN");

    const meRow = (
      await client.query(
        `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`,
      )
    ).rows[0];

    /**
     * 🔴 THE PROBE ROLE MUST NOT BE EXEMPT, AND THAT IS CHECKED RATHER
     * THAN ASSUMED. A probe run as a bypassing role reports "no leaks"
     * on a database with no policies at all — the most expensive green
     * there is.
     */
    let probeRole = null;
    const candidates = (
      await client.query(
        `SELECT rolname FROM pg_roles
          WHERE NOT rolsuper AND NOT rolbypassrls AND rolname = 'ordence_app'`,
      )
    ).rows;

    if (candidates.length > 0) {
      probeRole = candidates[0].rolname;
    } else if (meRow.su) {
      /**
       * ⚠️ CREATED INSIDE THE TRANSACTION AND ROLLED BACK WITH IT.
       * `CREATE ROLE` is transactional in PostgreSQL, so this leaves
       * nothing behind. It exists so the probe still runs on a database
       * that has no `ordence_app` — because "the role was missing" is
       * not an acceptable reason to stop checking tenant isolation.
       */
      probeRole = "zz_rls_probe_role";
      await client.query(`CREATE ROLE ${probeRole} NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${probeRole}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
      note(`no ordence_app here — probing as a temporary ${probeRole}, rolled back with the transaction`);
    } else {
      fail(
        "the cross-tenant probe cannot run: there is no NOSUPERUSER NOBYPASSRLS role to probe as, " +
          "and this connection is not a superuser so it cannot create one. Point DATABASE_URL at a " +
          "superuser on the throwaway database, or create ordence_app. This is not a skip: with no " +
          "probe, nothing in CI ever attempts a cross-tenant read.",
      );
      throw new Error("no probe role");
    }

    if (!meRow.su) {
      fail(
        `the cross-tenant probe needs a superuser to seed rows past foreign keys, and this ` +
          `connection is ${meRow.u}. Seeding would fail on every table with a parent.`,
      );
      throw new Error("not superuser");
    }

    await client.query(`SET LOCAL session_replication_role = replica`);

    /* ---- the two tenants, in the tenant list itself ---------------- */
    for (const [id, name] of [
      [TENANT_A, "zz-probe-a"],
      [TENANT_B, "zz-probe-b"],
    ]) {
      await client.query(
        `INSERT INTO tenants (id, clerk_org_id, name, slug, status)
         VALUES ($1, $2, $3, $4, 'active') ON CONFLICT DO NOTHING`,
        [id, `org_${name}`, name, name],
      );
    }

    /* ---- what has to be filled in on each table -------------------- */
    const cols = (
      await client.query(`
        SELECT c.relname                AS table_name,
               a.attname                AS column_name,
               t.typname                AS type_name,
               t.typtype                AS type_kind,
               format_type(a.atttypid, a.atttypmod) AS full_type,
               a.attnotnull             AS not_null,
               (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          JOIN pg_type t      ON t.oid = a.atttypid
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute x
                        WHERE x.attrelid = c.oid AND x.attname = 'tenant_id'
                          AND x.attnum > 0 AND NOT x.attisdropped)
         ORDER BY c.relname, a.attnum
      `)
    ).rows;

    const byTable = new Map();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
      byTable.get(c.table_name).push(c);
    }

    /**
     * ⚠️ NOT EVERY TABLE WITH A `tenant_id` IS READABLE BY ITS TENANT, AND
     * THE FIRST RUN OF THIS PROBE GOT THAT WRONG.
     *
     * `platform_entitlement_history` and `tenant_health_events` carry a
     * tenant_id and a policy whose USING clause is
     *
     *     (app_current_tenant_id() IS NULL OR app_platform_scope())
     *
     * — platform evidence ABOUT a workspace, deliberately not visible TO it.
     * The probe reported both as "invisible to their own tenant", which is
     * correct as an observation and wrong as a complaint.
     *
     * ⭐ SO THE CLASS IS DERIVED FROM THE POLICY, NOT FROM A LIST. If no
     * USING clause on the table mentions `tenant_id`, no tenant is supposed
     * to read it, and the assertion flips: BOTH tenants must see zero. That
     * is a stronger statement than skipping the table, and it needs no
     * allowlist to go stale.
     */
    const hasAnyPolicy = new Set(
      (
        await client.query(
          `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'`,
        )
      ).rows.map((r) => r.tablename),
    );

    const tenantReadable = new Set(
      (
        await client.query(`
          SELECT DISTINCT p.tablename
            FROM pg_policies p
           WHERE p.schemaname = 'public'
             -- A WORD-BOUNDARY MATCH, NOT LIKE '%tenant_id%', AND THE
             -- DIFFERENCE COST ONE FALSE FINDING ON THE FIRST RUN:
             -- app_current_tenant_id ENDS IN the string tenant_id, so the
             -- LIKE version matched every policy in the database, including
             -- the two platform-only ones whose USING clause mentions no
             -- column at all. PostgreSQL treats _ as a word character, so
             -- the boundary markers match the column and not the function.
             AND p.qual::text ~ '\\mtenant_id\\M'
        `)
      ).rows.map((r) => r.tablename),
    );

    /**
     * ⚠️ A LITERAL FROM THE TABLE'S OWN CHECK CONSTRAINTS, FOR THE RETRY.
     * Fifty-three tables refused the first seed on a CHECK — mostly
     * `status IN (...)`, `kind = ANY (ARRAY[...])`, `format_known`. Reading
     * the constraint text for a permitted value turns most of those from
     * "not proven" into "probed", and coverage of this probe is the whole
     * argument for it existing.
     *
     * 🔴 IT IS A HEURISTIC AND IT IS ALLOWED TO FAIL. A table it still
     * cannot seed is REPORTED BY NAME, never counted as passing. The
     * failure mode to avoid is not "the retry did not work" — it is a
     * retry that appears to work and silently narrows what was checked.
     */
    const checkLiterals = new Map();
    for (const row of (
      await client.query(`
        SELECT c.relname AS table_name, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c     ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND con.contype = 'c'
      `)
    ).rows) {
      if (!checkLiterals.has(row.table_name)) checkLiterals.set(row.table_name, new Map());
      const perColumn = checkLiterals.get(row.table_name);
      // (column)::text = ANY (ARRAY['a'::text, 'b'::text])  ·  col = 'a'::text  ·  col IN ('a','b')
      const m = /\(?"?([a-z_][a-z0-9_]*)"?\)?(?:::[a-z ]+)?\s*(?:=\s*ANY\s*\(\s*ARRAY\[|IN\s*\(|=)\s*'([^']*)'/i.exec(
        row.def,
      );
      if (m && !perColumn.has(m[1])) perColumn.set(m[1], m[2]);
    }

    /**
     * ⚠️ A VALUE PER TYPE, AND ANYTHING UNRECOGNISED IS REPORTED RATHER
     * THAN GUESSED AT. `null` here means "this probe could not seed the
     * table", which is counted and printed. It is not the same as "the
     * table is fine", and the two must never collapse into one number.
     */
    const enumLabel = new Map();
    for (const e of (
      await client.query(
        `SELECT t.typname, min(e.enumlabel) AS label
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
      )
    ).rows) {
      enumLabel.set(e.typname, e.label);
    }

    const literal = (c) => {
      if (c.column_name === "tenant_id") return "$1::uuid";
      const t = c.type_name;
      if (t.startsWith("_")) return `'{}'::${c.full_type}`;
      if (c.type_kind === "e") {
        const l = enumLabel.get(t);
        return l === undefined ? null : `'${l}'::${c.full_type}`;
      }
      switch (t) {
        case "uuid":      return "gen_random_uuid()";
        case "text": case "varchar": case "bpchar": case "name": case "citext":
          return `'zzprobe'::${c.full_type}`;
        case "int2": case "int4": case "int8":
          return `1::${c.full_type}`;
        case "numeric": case "float4": case "float8":
          return `1::${c.full_type}`;
        case "bool":      return "false";
        case "timestamptz": case "timestamp": return "now()";
        case "date":      return "current_date";
        case "time": case "timetz": return "now()::time";
        case "interval":  return "interval '0'";
        case "json":      return `'{}'::json`;
        case "jsonb":     return `'{}'::jsonb`;
        case "bytea":     return `'\\x'::bytea`;
        case "inet": case "cidr": return `'127.0.0.1'::${c.full_type}`;
        case "macaddr":   return `'00:00:00:00:00:00'::macaddr`;
        case "tsvector":  return `''::tsvector`;
        default:          return null;
      }
    };

    for (const [table, columns] of [...byTable.entries()].sort()) {
      if (NOT_TENANT_SCOPED.has(table)) continue;

      const needed = columns.filter(
        (c) => c.column_name === "tenant_id" || (c.not_null && !c.has_default),
      );
      const names = [];
      const values = [];
      let giveUp = null;
      for (const c of needed) {
        const v = literal(c);
        if (v === null) {
          giveUp = `${c.column_name} is ${c.full_type}, which this probe has no value for`;
          break;
        }
        names.push(`"${c.column_name}"`);
        values.push(v);
      }
      if (giveUp) {
        unseeded.push(`${table} (${giveUp})`);
        continue;
      }

      /**
       * ⚠️ A SAVEPOINT PER TABLE. A CHECK constraint this probe cannot
       * satisfy aborts the statement, and without a savepoint it would
       * abort the whole transaction and take the other 302 tables with
       * it. The failure is recorded and the probe carries on.
       */
      const insert = async (vals) => {
        await client.query("SAVEPOINT probe_seed");
        try {
          await client.query(
            `INSERT INTO "${table}" (${names.join(", ")}) VALUES (${vals.join(", ")})`,
            [TENANT_A],
          );
          await client.query("RELEASE SAVEPOINT probe_seed");
          return null;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT probe_seed");
          return String(err.message).split("\n")[0];
        }
      };

      /**
       * ⭐ THREE ATTEMPTS, EACH ONE A NAMED GUESS, AND THE THIRD IS THE LAST.
       *
       * The first pass covered 250 of 303 tables; the 53 refusals were
       * almost all CHECK constraints, and they fall into three families:
       *
       *   · `kind IN (…)`, `status = ANY (ARRAY[…])`  — attempt 2 reads a
       *      permitted literal out of the constraint definition itself.
       *   · `starts_at < ends_at`, `expiry_after_start`, `period_sane` —
       *      attempt 3 staggers the timestamps by column order instead of
       *      giving every one of them `now()`.
       *   · `*_hash_shape` — attempt 3 offers 64 hex characters.
       *
       * ⚠️ AND THEN IT STOPS. A fourth attempt would be guessing at
       * business rules (`legs_balance`, `gstin_checksum`,
       * `status_fraction_coherent`), and a probe that constructs a
       * plausible-looking GSTIN to satisfy a checksum is a probe whose
       * failures nobody can interpret. What is not proven is printed by
       * name; that is more useful than a higher number.
       */
      let seedErr = await insert(values);

      const lit = checkLiterals.get(table);
      const withLiterals = needed.map((c, i) =>
        c.column_name !== "tenant_id" && lit && lit.has(c.column_name)
          ? `'${lit.get(c.column_name).replace(/'/g, "''")}'::${c.full_type}`
          : values[i],
      );

      if (seedErr && lit && lit.size > 0) {
        const again = await insert(withLiterals);
        if (!again) seedErr = null;
      }

      if (seedErr) {
        let stagger = 0;
        const shaped = needed.map((c, i) => {
          if (c.column_name === "tenant_id") return values[i];
          if (["timestamptz", "timestamp"].includes(c.type_name)) {
            stagger += 1;
            return `now() + interval '${stagger} day'`;
          }
          if (c.type_name === "date") {
            stagger += 1;
            return `current_date + ${stagger}`;
          }
          if (["text", "varchar", "bpchar"].includes(c.type_name) &&
              /hash|digest|sha|checksum|fingerprint/i.test(c.column_name)) {
            return `'${"0123456789abcdef".repeat(4)}'::${c.full_type}`;
          }
          return withLiterals[i];
        });
        const again = await insert(shaped);
        if (!again) seedErr = null;
      }

      if (seedErr) {
        unseeded.push(`${table} (${seedErr})`);
        continue;
      }

      /* ---- read it back, as somebody row security applies to -------- */
      await client.query(`SET LOCAL ROLE ${probeRole}`);
      let asA = null;
      let asB = null;
      try {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_A]);
        asA = Number(
          (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
        );
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_B]);
        asB = Number(
          (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
        );
      } catch (err) {
        unreadable.push(`${table} (${String(err.message).split("\n")[0]})`);
      } finally {
        await client.query("RESET ROLE");
      }

      if (asA === null || asB === null) continue;
      probed += 1;

      if (asB > 0) {
        leaked += 1;
        fail(
          `🔴 CROSS-TENANT READ on ${table}: a row belonging to tenant A was visible to tenant B ` +
            `(${asB} row(s)) on a connection as ${probeRole}, which has NOBYPASSRLS. This is not a ` +
            `policy that could be improved — it is one customer reading another customer's data.`,
        );
      }

      if (!tenantReadable.has(table) && hasAnyPolicy.has(table)) {
        /* platform-only: the table HAS policies and none of their USING
         * clauses mentions tenant_id, so no tenant may read it. `asB > 0`
         * above already covers B.
         *
         * ⚠️ `hasAnyPolicy` IS THE SECOND HALF OF THE CONDITION AND IT WAS
         * MISSING ON THE FIRST RUN. A table with NO policy at all also has
         * no USING clause mentioning tenant_id, so it was classified as
         * "platform-only" and the probe complained that tenant A COULD read
         * its own row — on a table with no row security whatsoever, where
         * the real finding is the cross-tenant read reported just above.
         * Measured on a deliberately unprotected probe table: four correct
         * findings and one that read as the opposite of the truth. */
        platformOnly += 1;
        if (asA > 0) {
          fail(
            `${table}: no policy on this table filters on tenant_id — it is platform-only evidence ` +
              `ABOUT a workspace — and yet tenant A read its own row (${asA}). Either the policy ` +
              `acquired a tenant branch, or the table stopped being platform-only. Both are changes ` +
              `to who can see a workspace's health and entitlement history.`,
          );
        }
      } else if (asA === 0) {
        invisible += 1;
        fail(
          `${table}: the probe inserted a row for tenant A and tenant A could not see it, on a table ` +
            `whose policy DOES filter on tenant_id. Either the policy denies its own tenant, or ` +
            `${probeRole} lacks SELECT here. Reported because the "tenant B sees nothing" half of this ` +
            `test passes trivially on a table nobody can read, and a probe that cannot tell those ` +
            `apart proves nothing.`,
        );
      }
    }

    /**
     * ⚠️ AND THE PROBE IS CHECKED FOR VACUITY BEFORE ITS RESULT IS
     * BELIEVED. Zero tables probed is not zero leaks.
     */
    if (probed === 0) {
      fail(
        "the cross-tenant probe read back ZERO tables. It reported no leaks because it tested " +
          "nothing, which is the exact shape of every vacuous check this repository has found.",
      );
    }

    /**
     * 🔴 UNSEEDED TABLES ARE UNPROVEN, AND THEY ARE PRINTED BY NAME.
     * They are not failed today: a CHECK constraint this probe cannot
     * satisfy is a limitation of the probe, not evidence of a leak, and a
     * gate that goes red for a reason nobody can act on gets switched
     * off. But the number is stated on every run, and a rise in it means
     * coverage fell.
     */
    note(
      `probed ${probed}/${checked} tenant tables · ${leaked} cross-tenant read(s) · ` +
        `${platformOnly} platform-only (no tenant may read) · ${invisible} invisible to their own ` +
        `tenant · ${unseeded.length} NOT PROVEN, could not seed · ${unreadable.length} not readable`,
    );
    if (unseeded.length > 0) {
      console.log("   ⚠️  NOT PROVEN — this probe could not insert a row:");
      for (const u of unseeded.slice(0, 40)) console.log(`        ${u}`);
      if (unseeded.length > 40) console.log(`        …and ${unseeded.length - 40} more`);
    }
    if (unreadable.length > 0) {
      console.log("   ⚠️  NOT PROVEN — the probe role could not read:");
      for (const u of unreadable.slice(0, 40)) console.log(`        ${u}`);
    }
  } catch (err) {
    if (!["no probe role", "not superuser"].includes(err.message)) {
      fail(`the cross-tenant probe could not complete: ${err.message}`);
    }
  } finally {
    /**
     * ⚠️ ROLLBACK IN `finally`, AND IT IS ALLOWED TO FAIL SILENTLY. If the
     * transaction is already aborted the ROLLBACK still does the right
     * thing; if the connection died, releasing it is what matters. What
     * must never happen is a probe row surviving.
     */
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction is gone, which is the outcome we wanted */
    }
    client.release();
  }

  /* ---- and prove the rollback took ------------------------------- */
  const residue = (
    await pool.query(`SELECT count(*)::int AS n FROM tenants WHERE id = $1 OR id = $2`, [
      TENANT_A,
      TENANT_B,
    ])
  ).rows[0].n;
  if (residue !== 0) {
    fail(
      `${residue} probe tenant row(s) survived the ROLLBACK. The probe wrote to this database and ` +
        `did not clean up. Delete tenants ${TENANT_A} and ${TENANT_B} by hand.`,
    );
  } else {
    note("rollback verified — no probe rows remain");
  }

  /* ══════════════════════════════════════════════════════════════════ */

  if (failures > 0) {
    console.error(`\n❌ RLS coverage FAILED — ${failures} problem(s) across ${checked} tenant tables.\n`);
    process.exit(1);
  }

  console.log(
    `\n✅ RLS coverage complete — all ${checked} tenant-scoped tables enabled, forced and policied; ` +
      `row security applies to the application role; 0 drift findings; the schema contract matches; ` +
      `and ${probed} tables were probed with two real tenants and refused the cross-tenant read.`,
  );
} catch (err) {
  console.error(`::error::RLS coverage check could not run: ${err instanceof Error ? err.message : err}`);
  // ⚠️ FAILS CLOSED, unlike the billing gate. A check that cannot run is
  // not a check that passed — that confusion is exactly what let the
  // `.next/static` leak scan report ✅ on a directory it never read.
  process.exit(1);
} finally {
  await pool.end();
}
