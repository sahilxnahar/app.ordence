#!/usr/bin/env node
/**
 * Ordence , CI GATE 25: A SEALED PRIVILEGE MUST NEVER BE GRANTED
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BUG THIS GATE WAS WRITTEN THE DAY AFTER
 * ══════════════════════════════════════════════════════════════════════
 * The application role could delete six months of security history.
 *
 * `prune_security_events()` is SECURITY DEFINER and is the one sanctioned
 * way past the append-only trigger on `security_events`. 0012 refused it
 * to `ordence_app` and said so, in a comment inside the grant block:
 *
 *     -- Explicitly NOT granted: EXECUTE on prune_security_events(). The
 *     -- web application must not be able to delete security history
 *     -- under any circumstances, including via a function that is
 *     -- allowed to.
 *
 * 0087_hardening_narrow_grants.sql, line 282, seventy-five files later:
 *
 *     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean)  TO ordence_app;
 *
 * 0087 revoked EXECUTE on all functions from PUBLIC , correct and
 * overdue , and re-granted the thirty the application calls, with the
 * method in its own comment: "Signatures copied verbatim from the modules
 * that GRANT them." Twenty-nine of those thirty are granted by their
 * module to `ordence_app`. This one is granted to `ordence_maintenance`.
 * The signature was copied; the role was not read.
 *
 * ⚠️ THE LINE IS INDISTINGUISHABLE FROM ITS NEIGHBOURS. That is why
 * review did not catch it and why no amount of care would reliably catch
 * the next one. 0012 even shipped a verification query for exactly this
 * case , it prints "*** FAIL: the web application can delete security
 * history ***" , and it never fired, because it lives in 0012 and the
 * regression arrived in 0087. Nobody re-runs an old file's SELECTs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO: A REFUSAL IS A DECLARATION, NOT A COMMENT
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/sealed-grants.json` lists (role, object, privilege) triples
 * that must never be granted. This gate reads every .sql file in the
 * repository and fails the build on any GRANT that matches , whatever
 * file it is in, however many waves later, however ordinary it looks.
 *
 * The gate is static. It needs no database, so it runs on every push,
 * which is the entire point: the database check in 0012 was correct and
 * ran once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THE MATCHER MUST AND MUST NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * MUST match, because these are all real grants:
 *     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean) TO ordence_app;
 *     GRANT EXECUTE ON FUNCTION public.prune_security_events(int, bool) TO ordence_app;
 *     GRANT ALL     ON FUNCTION prune_security_events(integer, boolean) TO ordence_app;
 *     GRANT SELECT, DELETE ON security_events TO ordence_app;
 *     GRANT EXECUTE ON FUNCTION x() TO ordence_maintenance, ordence_app;
 *
 * MUST NOT match, because these are not:
 *     -- GRANT EXECUTE ON FUNCTION prune_security_events(...) TO ordence_app;   (comment)
 *     REVOKE EXECUTE ON FUNCTION prune_security_events(...) FROM ordence_app;
 *     GRANT EXECUTE ON FUNCTION prune_security_events(...) TO ordence_maintenance;
 *     'GRANT EXECUTE ... TO ordence_app'   inside a string literal in a NOTICE
 *
 * The comment case is the one that matters most, because the seal's own
 * documentation quotes the offending line, and a matcher that cannot tell
 * documentation from code would fail on the file that fixes the bug.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WAVE 15 (Track C) — PART TWO: THE MIGRATION LINTER
 * ══════════════════════════════════════════════════════════════════════
 * Three properties of a migration file are stated as rules across this
 * repository and enforced by nothing:
 *
 *   1. EVERY MIGRATION VERIFIES ITSELF and raises if the change did not
 *      take. 32 numbered files contain no `RAISE EXCEPTION` at all.
 *      `0126_updated_at_coverage.sql` is the argument: its Section 1
 *      failed with `relation "collations" does not exist` on every
 *      database it was ever applied to, and its Section 3 still printed
 *      `0126 PASS`, because with an empty exclusion list nothing can be
 *      uncovered. A migration that can succeed while doing nothing is the
 *      same defect as the `count(*) >= 10` gate.
 *
 *   2. NO UNSCOPED `DELETE` OR `UPDATE`. Currently zero violations —
 *      which is exactly when a rule is worth writing down, because the
 *      cost of adopting it is nil and it never gets cheaper.
 *
 *   3. NO COVERAGE ASSERTION ON A FLOOR. `CASE WHEN count(*) >= 10 THEN
 *      'PASS'` is in `0014_phase17_platform.sql` for a property that had
 *      to hold on 303 tables. It printed PASS at 48 and every later file
 *      copied the shape.
 *
 * ⚠️ WHY HERE RATHER THAN IN A NEW `scripts/check-migration-lint.mjs`.
 * A new gate needs an entry in `package.json`, in `scripts/gates.mjs` and
 * in the CI workflow, and `check:gate-coverage` (gate 24) FAILS the build
 * on a `check:*` script that is not in the manifest. All three of those
 * files are shared and owned by nobody this wave. A new script would
 * therefore be either a build failure or a file nothing runs — the
 * "built and unreachable" defect, committed while writing a gate against
 * it. This gate already reads every `.sql` file in the repository on
 * every push, which is precisely what the linter needs.
 * See PATCH-REQUEST-C.md for the split, if it is wanted later.
 *
 * ⚠️ AND THE BASELINES ARE RATCHETS, NOT TOLERANCES. A file listed below
 * that no longer violates its rule FAILS THE BUILD — "remove it from the
 * list". Without that, the list only grows, and a grandfather list that
 * can only grow is a rule that has been repealed slowly.
 * `scripts/check-sql-rls-writes.mjs` already carries a BEGIN/COMMIT
 * grandfather list of 44 files, and this one deliberately does NOT
 * duplicate that rule.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAL_FILE = join(ROOT, "scripts", "sealed-grants.json");

/* ────────────────────────────────────────────────────────────────────
 * 1. STRIP COMMENTS AND STRING LITERALS
 *
 * Not a full SQL parser and it does not need to be. It needs to know
 * that text inside `--`, `/* … *​/`, `'…'` and `$tag$ … $tag$` is not a
 * statement. Dollar-quoted bodies are KEPT, because a DO block can
 * legitimately contain `EXECUTE format('GRANT …')` and that is a real
 * grant , so only the single-quoted string inside it is blanked, which
 * is handled by the ordinary quote rule.
 * ──────────────────────────────────────────────────────────────────── */
function stripNonCode(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const two = sql.slice(i, i + 2);

    // line comment
    if (two === "--") {
      while (i < n && sql[i] !== "\n") {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // block comment, nestable in PostgreSQL
    if (two === "/*") {
      let depth = 1;
      i += 2;
      out += "  ";
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth += 1; out += "  "; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth -= 1; out += "  "; i += 2; continue; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // single-quoted literal, '' escapes
    if (sql[i] === "'") {
      out += " ";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
        if (sql[i] === "'") { out += " "; i += 1; break; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // dollar quote: keep the body, blank only the delimiters
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      out += " ".repeat(tag.length);
      i += tag.length;
      const close = sql.indexOf(tag, i);
      const bodyEnd = close === -1 ? n : close;
      // ⚠️ RECURSE. The body of a DO block is ordinary SQL and contains
      // ordinary `--` comments. Copying it verbatim was the first version
      // of this function and it reported the fix for the bug as the bug:
      // 0087's replacement comment QUOTES the offending GRANT, inside a
      // DO block, and an un-stripped body matched it.
      out += stripNonCode(sql.slice(i, bodyEnd));
      i = bodyEnd;
      if (close !== -1) { out += " ".repeat(tag.length); i += tag.length; }
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────
 * 2. FIND THE GRANTS
 * ──────────────────────────────────────────────────────────────────── */

/** GRANT <privs> ON [FUNCTION|TABLE|…] <object> TO <roles> */
const GRANT_RE =
  /\bGRANT\s+([\s\S]{1,400}?)\s+\bTO\s+([A-Za-z_][\w",\s]*?)\s*(?:WITH\s+GRANT\s+OPTION\s*)?;/gi;

/** CREATE|ALTER ROLE <name> … BYPASSRLS|SUPERUSER (without NO in front) */
const ROLE_ATTR_RE =
  /\b(?:CREATE|ALTER)\s+ROLE\s+([A-Za-z_]\w*)\s+([\s\S]{0,300}?);/gi;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function rolesIn(clause) {
  return clause
    .split(",")
    .map((r) => r.trim().replace(/^"(.*)"$/, "$1").toLowerCase())
    .filter(Boolean);
}

/**
 * Does a GRANT body name this object?
 *
 * ⚠️ Word-boundary, not `includes`. `security_events` must not be found
 * inside `security_events_archive`, which is a different table with
 * different rules.
 */
function namesObject(body, object) {
  const re = new RegExp(`(^|[^\\w.])(?:[a-z_]\\w*\\.)?${object}\\b`, "i");
  return re.test(body);
}

function grantsPrivilege(body, privilege) {
  const head = body.split(/\bON\b/i)[0] ?? body;
  if (/\bALL\b/i.test(head)) return true;
  return new RegExp(`\\b${privilege}\\b`, "i").test(head);
}

/* ────────────────────────────────────────────────────────────────────
 * 3. WALK
 * ──────────────────────────────────────────────────────────────────── */

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "_superseded"]);

function sqlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) sqlFiles(full, acc);
    else if (entry.toLowerCase().endsWith(".sql")) acc.push(full);
  }
  return acc;
}

/* ────────────────────────────────────────────────────────────────────
 * 4. RUN
 * ──────────────────────────────────────────────────────────────────── */

let raw;
try {
  raw = JSON.parse(readFileSync(SEAL_FILE, "utf8"));
} catch (err) {
  console.error(`❌ cannot read ${relative(ROOT, SEAL_FILE)}: ${err.message}`);
  process.exit(1);
}

const seals = raw.seals ?? [];
if (seals.length === 0) {
  console.error("❌ scripts/sealed-grants.json declares no seals. An empty seal list is a gate that cannot fail.");
  process.exit(1);
}

for (const seal of seals) {
  for (const field of ["id", "role", "object", "privilege", "kind", "why"]) {
    if (!seal[field]) {
      console.error(`❌ seal ${seal.id ?? "(unnamed)"} is missing \`${field}\`.`);
      process.exit(1);
    }
  }
  if (String(seal.why).length < 40) {
    console.error(`❌ seal ${seal.id}: \`why\` is ${String(seal.why).length} characters. A seal nobody can justify is a seal somebody will delete.`);
    process.exit(1);
  }
}

const files = sqlFiles(ROOT);
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const original = readFileSync(file, "utf8");
  const code = stripNonCode(original);

  /* ---- object privileges ---- */
  for (const m of code.matchAll(GRANT_RE)) {
    const body = m[1] ?? "";
    const roles = rolesIn(m[2] ?? "");

    for (const seal of seals) {
      if (seal.kind === "role-attribute") continue;
      if (!roles.includes(seal.role.toLowerCase())) continue;
      if (!namesObject(body, seal.object)) continue;
      if (!grantsPrivilege(body, seal.privilege)) continue;

      violations.push({
        seal,
        file: rel,
        line: lineOf(code, m.index ?? 0),
        text: m[0].replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  }

  /* ---- role attributes ---- */
  for (const m of code.matchAll(ROLE_ATTR_RE)) {
    const role = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";

    for (const seal of seals) {
      if (seal.kind !== "role-attribute") continue;
      if (role !== seal.role.toLowerCase()) continue;

      // NOBYPASSRLS / NOSUPERUSER are the CORRECT form and must not match.
      const re = new RegExp(`(^|[^\\w])(?<!NO)${seal.privilege}\\b`, "i");
      const cleaned = attrs.replace(/\bNO(BYPASSRLS|SUPERUSER)\b/gi, " ");
      if (!re.test(cleaned)) continue;

      violations.push({
        seal,
        file: rel,
        line: lineOf(code, m.index ?? 0),
        text: m[0].replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 5. THE MIGRATION LINTER
 * ════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ NUMBERED MIGRATIONS ONLY.
 *
 * `ALL-IN-ONE-SETUP.sql` is a legacy aggregate that is not in the run
 * order; the `RUN-THESE-IN-ORDER-*`, `VERIFY-*` and `*-neon-safe` files
 * are operator worksheets; `DRILL-*` files are destructive by design and
 * never run against a real database. None of them is a migration, and
 * holding them to a migration's rules would produce noise that teaches
 * people to ignore this gate.
 */
const MIGRATION_RE = /^\d{4}_.+\.sql$/;

/**
 * 🔴 GRANDFATHERED: 32 NUMBERED MIGRATIONS CONTAIN NO `RAISE EXCEPTION`.
 *
 * Every one is already applied to production. Editing an applied
 * migration is re-running history under the same name — the reasoning
 * `check-sql-rls-writes.mjs` sets out for its own list — so they are
 * corrected by a later numbered file if they ever need to be, and this
 * list is the inventory of what is not yet corrected.
 *
 * ⚠️ THE LIST IS A RATCHET. Remove a file from it the day that file
 * gains a real verification section; leaving it here after it is fixed
 * FAILS this gate, so the list cannot quietly become the permanent state.
 */
const NO_SELF_VERIFY_GRANDFATHERED = new Set([
  "0017_change_log.sql",
  "0022_phase29_admin_console.sql",
  "0039_tables_paste_only.sql",
  "0044_tenant_patterns.sql",
  "0045_notifications.sql",
  "0046_deployment_flows_governance.sql",
  "0048_credit_limits.sql",
  "0051_sales_posting_accounts.sql",
  "0052_booking_possession.sql",
  "0053_time_and_billing.sql",
  "0054_eway_bills.sql",
  "0079_rls_opt_in_and_telemetry.sql",
  "0080_orders_place_of_supply.sql",
  "0081_audit_hash_chain.sql",
  "0086_policy_platform_platform_tables.sql",
  "0087_hardening_narrow_grants.sql",
  "0088_hardening_auth_events.sql",
  "0089_hardening_login_lockouts.sql",
  "0092_reserve_clerk_hosts.sql",
  "0093_user_notification_preferences.sql",
  "0094_wage_payment_date_and_settlement.sql",
  "0095_employee_tax_regime_elections.sql",
  "0097_email_outbox_and_suppressions.sql",
  "0098_dunning_service_evidence.sql",
  "0101_multi_currency_and_fx.sql",
  "0103_reserve_resend_hosts.sql",
  "0104_analytics_views_carry_currency.sql",
  "0105_per_tenant_ai_provider_credentials.sql",
  "0106_tds_foreign_payments_rule_26.sql",
  "0109_payroll_entitlement_grandfather.sql",
  "0111_deemed_service_and_notice_authority.sql",
  "0120_schema_migrations.sql",
]);

/**
 * 🔴 GRANDFATHERED: THREE FILES ASSERT COVERAGE ON A FLOOR.
 *
 *   0006  CASE WHEN count(*) >= 1  … and >= 23
 *   0007  CASE WHEN count(*) >= 25
 *   0014  CASE WHEN count(*) FILTER (WHERE tgname = '…') >= 10
 *
 * 0014's is the one that printed PASS at 48 of 303 tables and let 255
 * tenant tables go without an impersonation delete guard for ninety
 * module files. `0125_impersonation_guard_coverage.sql` replaced the
 * PROPERTY with an exact assertion; the floor itself is still sitting in
 * 0014, where nobody re-runs it. Same ratchet rule as above.
 */
const FLOOR_ASSERTION_GRANDFATHERED = new Set([
  "0006_phase8_storage.sql",
  "0007_phase9_portals.sql",
  "0014_phase17_platform.sql",
]);

/**
 * 🔴 GRANDFATHERED: 60 NUMBERED MIGRATIONS WHOSE ONLY `RAISE EXCEPTION`
 *    IS INSIDE A `CREATE FUNCTION` BODY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 17 SWEEP — "WHAT COULD RULE 1 MISS?"
 * ══════════════════════════════════════════════════════════════════════
 * Rule 1 asks whether the file contains a `RAISE EXCEPTION`. A file that
 * CREATES a trigger function containing one satisfies that and verifies
 * NOTHING at apply time: the function is a thing the file left behind for
 * later, not a check the file ran on itself.
 *
 * ⚠️ THAT IS THE 0126 SHAPE EXACTLY. 0126 had a verification section and
 * it still printed PASS while half the file had not run. A file with no
 * apply-time check at all cannot even get that far.
 *
 * Measured over the assembled tree: **60 of 146** numbered migrations are
 * in this state, including `0001_rls_and_audit_guard.sql`. So the rule is
 * tightened and the 60 are listed, which is the same shape as the two
 * lists above and blocks nobody: every file that exists today either
 * passes the strict rule or is named here.
 *
 * 🔴 THIS IS THE ONE RULE IN THIS FILE THAT COULD NEWLY FLAG A MIGRATION
 * TRACK C HAS NOT SEEN. Track A's 0129–0132 were not in the tree this
 * list was measured against. If one of them fails on
 * `self-verification-in-function`, **add its filename to this list** —
 * that is the mechanism, not an argument to have. Do not weaken the rule
 * and do not delete the entry when the file is later fixed: a name here
 * that no longer violates fails the build with "remove it from the list".
 */
const VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED = new Set([
  "0001_rls_and_audit_guard.sql",
  "0002_phase2_rls.sql",
  "0003_phase3_rls.sql",
  "0005_phase5_controls.sql",
  "0006_phase8_storage.sql",
  "0007_phase9_portals.sql",
  "0011_phase19_telemetry.sql",
  "0012_phase20_secops.sql",
  "0014_phase17_platform.sql",
  "0015_phase16_invoicing.sql",
  "0016_phase22_sales.sql",
  "0020_phase25_views.sql",
  "0028_phase39_orders.sql",
  "0029_phase40_inventory.sql",
  "0030_phase42_land.sql",
  "0031_phase44_ra_bills.sql",
  "0040_stock_reservation_floor.sql",
  "0041_contracting_depth.sql",
  "0042_mcp_access.sql",
  "0049_sales_invoices.sql",
  "0050_sales_credit_notes.sql",
  "0055_batch_serial_returns.sql",
  "0056_transfers_landed_cost.sql",
  "0057_pricing_discounts.sql",
  "0058_legal_matters.sql",
  "0059_court_fees_disbursements.sql",
  "0060_tasks_activities_calendar.sql",
  "0061_crm_consent_messaging.sql",
  "0063_purchase_orders_payments.sql",
  "0064_integration_frame.sql",
  "0065_lead_intake.sql",
  "0066_utility_messaging.sql",
  "0067_campaigns.sql",
  "0068_order_rhythm.sql",
  "0069_connection_probes.sql",
  "0070_bank_reconciliation.sql",
  "0071_tenant_agents.sql",
  "0073_period_lock_and_reorder.sql",
  "0074_platform_control.sql",
  "0075_payroll.sql",
  "0077_monthly_return.sql",
  "0078_real_estate_completion.sql",
  "0082_leave_and_attendance.sql",
  "0083_credit_control_and_dunning.sql",
  "0084_cost_centres_and_budgets.sql",
  "0085_appraisals_and_org.sql",
  "0090_period_close_message_normalization.sql",
  "0091_slug_authority.sql",
  "0096_advances_loans_and_reimbursements.sql",
  "0099_stock_movement_valuation.sql",
  "0100_fixed_asset_register_and_depreciation.sql",
  "0102_bank_reconciliation_statement_and_lock.sql",
  "0112_bank_charge_itc_posting.sql",
  "0113_dpdp_data_principal_requests.sql",
  "0114_seat_grants_and_pending_seats.sql",
  "0115_ai_credential_policy_and_usage.sql",
  "0116_data_exports.sql",
  "0117_import_runs_and_mapping.sql",
  "0118_drawing_register.sql",
  "0119_rate_limit_counters.sql",
]);

/**
 * Blank the body of every `CREATE FUNCTION`, keep `DO` bodies.
 *
 * ⚠️ THE OPPOSITE OF `stripToTopLevel`, AND BOTH ARE NEEDED. A `RAISE
 * EXCEPTION` that verifies the migration lives inside a `DO` block by
 * construction; one that belongs to a trigger function lives inside a
 * `CREATE FUNCTION` body. Telling those apart is the whole rule, and no
 * single view of the file can do it.
 */
function stripCommentsKeepDollar(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < n && sql[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      i += 2;
      out += "  ";
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth += 1; out += "  "; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth -= 1; out += "  "; i += 2; continue; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    // a single-quoted literal is COPIED, not blanked: `stripNonCode` blanks it
    // later. Blanking here would be the same work twice and would let a
    // literal containing `--` eat the rest of a real line.
    if (sql[i] === "'") {
      out += sql[i];
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
        out += sql[i];
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function stripFunctionBodies(sql) {
  let out = sql;
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b[\s\S]*?\bAS\s+(\$[A-Za-z_]\w*\$|\$\$)/gi;
  let m;
  while ((m = re.exec(out)) !== null) {
    const tag = m[1];
    const start = m.index + m[0].length;
    const close = out.indexOf(tag, start);
    const end = close === -1 ? out.length : close + tag.length;
    out =
      out.slice(0, start) +
      out.slice(start, end).replace(/[^\n]/g, " ") +
      out.slice(end);
    re.lastIndex = end;
  }
  return out;
}

/**
 * ⚠️ A SEPARATE STRIPPER FROM `stripNonCode`, AND THE DIFFERENCE IS THE
 * DOLLAR-QUOTED BODY.
 *
 * `stripNonCode` KEEPS function bodies on purpose, because a DO block can
 * contain a real `EXECUTE format('GRANT …')`. The linter needs the
 * opposite: a plpgsql body is full of `BEGIN`, `UPDATE` and `DELETE`
 * keywords that are not file-level statements, and counting them would
 * make every well-written migration look like a violation.
 */
function stripToTopLevel(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) out += sql[k] === "\n" ? "\n" : " ";
  };

  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") { depth += 1; j += 2; continue; }
        if (sql.slice(j, j + 2) === "*/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? n : close + tag.length;
      blank(i, end);
      i = end;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

const lintProblems = [];
const lintFixed = [];
let migrationsLinted = 0;

const migrationFiles = readdirSync(join(ROOT, "SQL-FILES"))
  .filter((f) => MIGRATION_RE.test(f))
  .sort();

if (migrationFiles.length === 0) {
  console.error(
    "❌ no numbered migrations found in SQL-FILES/ — the migration linter would pass " +
      "vacuously, which is worse than failing.",
  );
  process.exit(1);
}

/**
 * ⭐ ONE FUNCTION, CALLED BY THE FILE WALK AND BY `--self-test`.
 *
 * ⚠️ THE SELF-TEST MUST EXERCISE THE SHIPPED CODE, NOT A COPY OF ITS
 * REGEXES. Wave 15's floor rule was checked against a copy and the copy
 * was right; the shipped one had `>=?` and matched `<>`, and every track
 * was blocked. A test that re-implements the thing it tests can only ever
 * find bugs in itself.
 */
function lintMigration(file, raw, problems, fixed) {
  const topLevel = stripToTopLevel(raw);
  /**
   * ⚠️ AND A THIRD VIEW OF THE SAME FILE, WHICH IS NOT ONE VIEW TOO MANY.
   * `stripNonCode` (section 1) removes comments and string literals but
   * KEEPS dollar-quoted bodies. That is the right lens for a rule about
   * something written INSIDE a DO block.
   *
   * 🔴 THE FIRST DRAFT SCANNED THE RAW TEXT FOR THE FLOOR RULE AND
   * REPORTED TWO FILES THAT QUOTE 0014'S FLOOR IN A COMMENT — including
   * `0140_tenant_table_drift_detector.sql`, this wave's own file, whose
   * header explains why that floor was wrong. A linter that fails on the
   * document describing the defect is the same mistake the sealed-grants
   * matcher above was written to avoid, made again one section later.
   */
  const code = stripNonCode(raw);

  /* ---- RULE 1: the file verifies itself -------------------------- */
  /**
   * ⚠️ MEASURED ON `code`, NOT ON `topLevel`. A `RAISE EXCEPTION` lives
   * INSIDE a DO block by construction, which is exactly what
   * `stripToTopLevel` blanks out. Reading that view here would report
   * every migration in the repository as unverified — a check that fails
   * on everything is indistinguishable from one that is broken, and gets
   * switched off just as fast. And not the raw text either: a file that
   * only MENTIONS "RAISE EXCEPTION" in its header would pass.
   */
  const verifies = /\bRAISE\s+EXCEPTION\b/i.test(code);
  if (!verifies && !NO_SELF_VERIFY_GRANDFATHERED.has(file)) {
    problems.push({
      file,
      rule: "self-verification",
      detail:
        "contains no RAISE EXCEPTION. A migration that cannot fail cannot tell you it did " +
        "nothing. 0126 Section 1 errored on every database it was ever applied to and the " +
        "file still printed PASS.",
    });
  }
  if (verifies && NO_SELF_VERIFY_GRANDFATHERED.has(file)) {
    fixed.push({
      file,
      rule: "self-verification",
      detail:
        "now contains a RAISE EXCEPTION and is still on NO_SELF_VERIFY_GRANDFATHERED. " +
        "Remove it from that list — a grandfather list that only grows is a repealed rule.",
    });
  }

  /* ---- RULE 1b: and the RAISE must be the FILE's, not a function's -- */
  /**
   * ⚠️ THE ORDER OF THESE THREE VIEWS IS LOAD-BEARING, AND GETTING IT
   * WRONG REPORTED ALL 60 GRANDFATHERED FILES AS "NOW FIXED" ON THE
   * FIRST RUN.
   *
   * `stripNonCode` blanks the `$fn$` DELIMITERS while keeping the body,
   * so `stripFunctionBodies(code)` has nothing left to find a function
   * body BY — it matches nothing and every file looks like it verifies
   * outside one. The dollar quotes have to survive until the function
   * bodies have been removed:
   *
   *     raw → comments out, dollar quotes kept   (stripCommentsKeepDollar)
   *         → CREATE FUNCTION bodies blanked     (stripFunctionBodies)
   *         → string literals out                (stripNonCode)
   */
  const verifiesOutsideFunction = /\bRAISE\s+EXCEPTION\b/i.test(
    stripNonCode(stripFunctionBodies(stripCommentsKeepDollar(raw))),
  );
  if (verifies && !verifiesOutsideFunction) {
    if (!VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED.has(file)) {
      problems.push({
        file,
        rule: "self-verification-in-function",
        detail:
          "its only RAISE EXCEPTION is inside a CREATE FUNCTION body, so the file verifies " +
          "nothing when it is applied — it leaves behind a function that might raise later. " +
          "Add a DO block that re-reads the catalog and raises if the change did not take. " +
          "If this file is genuinely one of the pre-existing 60, add its name to " +
          "VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED rather than weakening the rule.",
      });
    }
  } else if (verifiesOutsideFunction && VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED.has(file)) {
    fixed.push({
      file,
      rule: "self-verification-in-function",
      detail:
        "now verifies itself outside a function body and is still on " +
        "VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED. Remove it from that list.",
    });
  }

  /* ---- RULE 2: no unscoped DELETE, UPDATE or TRUNCATE ------------ */
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ WAVE 17 SWEEP — THREE SHAPES THIS RULE USED TO WALK PAST
   * ══════════════════════════════════════════════════════════════════
   * The rule asked one question: is there a `WHERE`? Three ways to
   * delete every row answer "yes" or are not a DELETE at all:
   *
   *   DELETE FROM t WHERE true;      ← a WHERE that scopes nothing
   *   DELETE FROM t WHERE 1 = 1;     ← the same, spelled defensively
   *   TRUNCATE t;                    ← not matched at all, and it is
   *                                    the most destructive of the three
   *
   * ⚠️ `WHERE true` IS ONLY UNSCOPED WHEN IT IS THE WHOLE PREDICATE.
   * `WHERE true AND tenant_id = app_current_tenant_id()` is a perfectly
   * ordinary generated predicate and must NOT match — which is why the
   * pattern is anchored to the end of the statement rather than being a
   * search for the word "true".
   *
   * 🔴 AND A LIMIT, WRITTEN DOWN RATHER THAN LEFT TO BE DISCOVERED:
   * `EXECUTE 'TRUNCATE change_log'` inside a DO block is INVISIBLE here.
   * The statement lives in a single-quoted literal, and `stripNonCode`
   * blanks those on purpose — that is what stops `RAISE NOTICE 'GRANT
   * EXECUTE …'` being reported as a grant. Reading inside string
   * literals would bring back the whole false-positive class this gate
   * was written to avoid, so the limit is accepted and stated. There is
   * a case for it in `--self-test` marked as expected-to-miss.
   */
  const UNSCOPED_WHERE = /\bWHERE\s+(?:TRUE|1\s*=\s*1)\s*$/i;

  for (const m of topLevel.matchAll(
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?([a-z_][\w."]*)([^;]*);/gi,
  )) {
    const tail = (m[2] ?? "").trim();
    const noWhere = !/\bWHERE\b/i.test(tail);
    const emptyWhere = UNSCOPED_WHERE.test(tail);
    if (noWhere || emptyWhere) {
      problems.push({
        file,
        rule: "unscoped-delete",
        detail:
          `DELETE FROM ${m[1]}${emptyWhere ? " WHERE " + tail.replace(/^.*\bWHERE\b/i, "").trim() : " with no WHERE clause"}` +
          ". Every row, on a table this file may not own.",
      });
    }
  }

  for (const m of topLevel.matchAll(
    /\bUPDATE\s+(?:ONLY\s+)?([a-z_][\w."]*)\s+SET\b([^;]*);/gi,
  )) {
    const tail = (m[2] ?? "").trim();
    const noWhere = !/\bWHERE\b/i.test(tail);
    const emptyWhere = UNSCOPED_WHERE.test(tail);
    if (noWhere || emptyWhere) {
      problems.push({
        file,
        rule: "unscoped-update",
        detail: `UPDATE ${m[1]} … SET ${noWhere ? "with no WHERE clause" : "WHERE " + tail.replace(/^.*\bWHERE\b/i, "").trim()}. Every row.`,
      });
    }
  }

  // ⚠️ NO EXCEPTION FOR A "SAFE" TRUNCATE, BECAUSE THERE ISN'T ONE.
  // TRUNCATE has no predicate: RESTART IDENTITY, CASCADE and ONLY all
  // still remove every row in the table. A migration that needs to empty
  // a table can say so in a DELETE with a predicate somebody can read.
  for (const m of topLevel.matchAll(
    /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([a-z_][\w."]*)/gi,
  )) {
    problems.push({
      file,
      rule: "unscoped-truncate",
      detail: `TRUNCATE ${m[1]}. There is no scoped TRUNCATE — it removes every row of every tenant, and it cannot be undone by a policy.`,
    });
  }

  /* ---- RULE 3: no coverage assertion on a floor ------------------ */
  /**
   * ⚠️ `HAVING count(*) > 1` IS NOT A FLOOR AND MUST NOT MATCH. It is
   * the ordinary duplicate-detection idiom and it appears in five files
   * doing exactly the right thing. A matcher that flagged it would be
   * wrong five times out of nine on its first run, and a linter that is
   * wrong more often than it is right gets deleted rather than fixed.
   * The floor idiom is a count compared to a literal in a PASS/FAIL
   * DECISION — `CASE WHEN`, or an `IF` that raises.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 WAVE 17 — THIS RULE BLOCKED EVERY TRACK ON A ONE-CHARACTER BUG
   * ══════════════════════════════════════════════════════════════════
   * The comparison was written `>=?\s*\d+`. Track A's `0132` contains
   *
   *     IF (SELECT count(*) …) <> 2 THEN RAISE
   *
   * which is an EXACT assertion — the precise thing this rule is asking
   * people to write — and it matched, because **`<>` contains `>`**.
   * Integration fixed it with a negative lookbehind and recorded why in
   * the file rather than patching silently. This is the confirmed fix,
   * plus the sweep for the same class that the fix asked for.
   *
   * ⚠️ THE LESSON GENERALISES AND IT IS NOT "BE CAREFUL WITH REGEX".
   * A rule that names one shape as wrong must be able to say, for every
   * OTHER shape, whether it matches. Two questions, asked of this rule
   * and of the two above it, and the answers are
   * executable: `node scripts/check-sealed-grants.mjs --self-test`.
   *
   *   1. WHAT EXACT ASSERTION COULD THIS FLAG?
   *        `<>`  ← the reported bug, fixed by (?<![<>=!-])
   *        `->>` and `->`  — the JSON operators both end in `>`
   *        `>>`  — bit shift
   *      All four are excluded by the lookbehind, and all four are in
   *      the case list, because a fix with no failing case attached is
   *      a fix nobody can re-check.
   *
   *   2. WHAT FLOOR COULD THIS MISS?
   *        🔴 `IF count(*) < 100 THEN RAISE EXCEPTION` — THE SAME
   *        DEFECT WRITTEN THE OTHER WAY ROUND, and the rule was blind
   *        to it. It is character for character the CI step this whole
   *        gate exists because of:
   *            if [ "$COUNT" -lt 100 ]; then exit 1; fi
   *        The `<` direction is now matched, and `<>` is excluded from
   *        it by a negative LOOKAHEAD for the same reason `>` needs the
   *        lookbehind.
   *
   * ⚠️ AND ONE FLOOR IT STILL MISSES, STATED RATHER THAN HIDDEN:
   *
   *     SELECT count(*) INTO n FROM …;
   *     IF n >= 10 THEN 'PASS'
   *
   * The count and the comparison are in different statements, so no
   * regex over one statement can connect them. Catching it needs
   * dataflow. It is written down here instead of being quietly absent,
   * because a reader who believes this rule is exhaustive will write
   * exactly that shape.
   */
  const CMP = String.raw`(?:(?<![<>=!~-])>=?|(?<![<>=!~-])<(?!>)=?)`;
  const floorRe = new RegExp(
    String.raw`\b(?:CASE\s+WHEN|IF)\s+[^;]{0,200}?count\s*\(\s*\*\s*\)[^;]{0,120}?` +
      CMP +
      String.raw`\s*\d+`,
    "gi",
  );
  const floors = [...code.matchAll(floorRe)];
  const sawFloor = floors.length > 0;
  if (sawFloor && !FLOOR_ASSERTION_GRANDFATHERED.has(file)) {
    problems.push({
      file,
      rule: "floor-assertion",
      detail:
        `${floors[0][0].replace(/\s+/g, " ").slice(0, 90)}… — a coverage assertion on a FLOOR. ` +
        "A floor measures how much was done right and cannot see what was done wrong. " +
        "0014 asserted >= 10 for a property that had to hold on 303 tables and printed PASS " +
        "at 48. Assert the exact count, or assert that the list of exceptions is empty.",
    });
  }
  if (!sawFloor && FLOOR_ASSERTION_GRANDFATHERED.has(file)) {
    fixed.push({
      file,
      rule: "floor-assertion",
      detail: "no longer contains a floor assertion — remove it from FLOOR_ASSERTION_GRANDFATHERED.",
    });
  }
}

/* ────────────────────────────────────────────────────────────────────
 * 6. SELF-TEST — `node scripts/check-sealed-grants.mjs --self-test`
 *
 * Every case is a shape the rules must or must not match, and each one
 * exists because of a specific mistake:
 *
 *   `<>` and `->>`   the wave-15 bug that blocked every track, and its
 *                    two nearest neighbours
 *   `< 100`          the floor written the other way round, which the
 *                    rule was blind to
 *   `WHERE true`     a WHERE clause that scopes nothing
 *   `TRUNCATE`       not a DELETE, and worse than one
 *   RAISE in a fn    a file that leaves a check behind instead of
 *                    running one
 *
 * ⚠️ ADD A CASE BEFORE CHANGING A REGEX. That is the whole discipline
 * this section exists to enforce, and it is cheap: one line here.
 * ──────────────────────────────────────────────────────────────────── */

const SELF_TEST_CASES = [
  // [id, sql, expected rule id or null]
  ["exact-neq-is-not-a-floor",
   "DO $$ BEGIN IF (SELECT count(*) FROM pg_policies) <> 2 THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["exact-neq-with-filter",
   "DO $$ BEGIN IF count(*) FILTER (WHERE a) <> 10 THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["json-arrow-is-not-a-floor",
   "DO $$ BEGIN IF (SELECT count(*) FROM t WHERE p ->> 'k' = 'v') <> 3 THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["equality-is-not-a-floor",
   "DO $$ BEGIN IF (SELECT count(*) FROM t) = 6 THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["having-count-gt-1-is-dedup",
   "SELECT a FROM t GROUP BY a HAVING count(*) > 1;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["floor-ge",
   "DO $$ BEGIN IF (SELECT count(*) FROM t) >= 10 THEN RAISE EXCEPTION 'x'; END IF; END $$;", "floor-assertion"],
  ["floor-gt",
   "DO $$ BEGIN IF (SELECT count(*) FROM t) > 100 THEN RAISE EXCEPTION 'x'; END IF; END $$;", "floor-assertion"],
  ["floor-lt-the-inverse",
   "DO $$ BEGIN IF (SELECT count(*) FROM pg_tables) < 100 THEN RAISE EXCEPTION 'too few'; END IF; END $$;", "floor-assertion"],
  ["floor-le-the-inverse",
   "DO $$ BEGIN IF (SELECT count(*) FROM t) <= 5 THEN RAISE EXCEPTION 'too few'; END IF; END $$;", "floor-assertion"],
  ["floor-quoted-in-a-comment",
   "-- 0014 wrote CASE WHEN count(*) >= 10 THEN 'PASS' and it passed at 48\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["delete-no-where",
   "DELETE FROM tenants;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-delete"],
  ["delete-where-true",
   "DELETE FROM tenants WHERE true;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-delete"],
  ["delete-where-1-eq-1",
   "DELETE FROM tenants WHERE 1 = 1;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-delete"],
  ["delete-where-true-and-scoped-is-fine",
   "DELETE FROM t WHERE true AND tenant_id = app_current_tenant_id();\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["delete-with-a-real-predicate",
   "DELETE FROM change_log\n WHERE changed_at < now() - interval '180 days';\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["update-no-where",
   "UPDATE plans SET name = 'x';\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-update"],
  ["update-where-true",
   "UPDATE plans SET name = 'x' WHERE TRUE;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-update"],
  ["truncate",
   "TRUNCATE TABLE change_log;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-truncate"],
  ["truncate-restart-identity",
   "TRUNCATE TABLE change_log RESTART IDENTITY CASCADE;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", "unscoped-truncate"],
  ["delete-inside-a-function-body-is-scoped-by-its-loop",
   "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN DELETE FROM change_log; END $fn$;\nDO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;", null],
  ["no-raise-at-all",
   "SELECT 1;", "self-verification"],
  ["raise-only-inside-create-function",
   "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'no'; END $fn$;", "self-verification-in-function"],
  ["raise-in-a-do-block-is-real-verification",
   "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class) THEN RAISE EXCEPTION 'missing'; END IF; END $$;", null],
  ["raise-in-both-counts",
   "CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'a'; END $fn$;\nDO $$ BEGIN IF true THEN RAISE EXCEPTION 'b'; END IF; END $$;", null],
  /**
   * ⚠️ EXPECTED TO MISS, AND LISTED SO THE MISS IS A DECISION.
   * The statement lives in a single-quoted literal, and the stripper
   * blanks those on purpose — that is what stops `RAISE NOTICE 'GRANT
   * EXECUTE …'` being reported as a grant. Reading inside literals would
   * bring back the whole false-positive class.
   */
  ["dynamic-truncate-is-invisible-and-that-is-known",
   "DO $$ BEGIN EXECUTE 'TRUNCATE change_log'; RAISE EXCEPTION 'x'; END $$;", null],
];

if (process.argv.includes("--self-test")) {
  let failed = 0;
  for (const [id, sql, want] of SELF_TEST_CASES) {
    const p = [];
    const f = [];
    // ⚠️ a name that is on no grandfather list, so the rules apply in full
    lintMigration("9999_self_test.sql", sql, p, f);
    const rules = p.map((x) => x.rule);
    const ok = want === null ? rules.length === 0 : rules.includes(want);
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${id.padEnd(46)} expected=${want ?? "(clean)"} got=${rules.join(",") || "(clean)"}`,
    );
  }
  console.log(
    failed === 0
      ? `\n✅ ${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length} lint cases pass`
      : `\n🔴 ${failed}/${SELF_TEST_CASES.length} lint cases FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

for (const file of migrationFiles) {
  migrationsLinted += 1;
  lintMigration(
    file,
    readFileSync(join(ROOT, "SQL-FILES", file), "utf8"),
    lintProblems,
    lintFixed,
  );
}

console.log(`sealed-grants: ${seals.length} seal(s) checked against ${files.length} .sql file(s)`);
console.log(
  `migration lint: ${migrationsLinted} numbered migration(s) · ` +
    `${NO_SELF_VERIFY_GRANDFATHERED.size} grandfathered without self-verification · ` +
    `${VERIFY_ONLY_IN_FUNCTION_GRANDFATHERED.size} verifying only inside a function body · ` +
    `${FLOOR_ASSERTION_GRANDFATHERED.size} grandfathered on a floor assertion`,
);

if (violations.length === 0 && lintProblems.length === 0 && lintFixed.length === 0) {
  console.log("✅ no sealed privilege is granted anywhere in the repository");
  console.log("✅ every numbered migration verifies itself, scopes its writes, and asserts exactly");
  process.exit(0);
}

if (lintProblems.length > 0 || lintFixed.length > 0) {
  console.error("");
  console.error("🔴 MIGRATION LINT");
  console.error("");
  for (const p of [...lintProblems, ...lintFixed]) {
    console.error(`::error::SQL-FILES/${p.file} [${p.rule}] ${p.detail}`);
  }
  console.error("");
}

if (violations.length === 0) {
  process.exit(1);
}

console.error("");
console.error("🔴 A SEALED PRIVILEGE IS GRANTED.");
console.error("");

for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    seal      : ${v.seal.id}`);
  console.error(`    refuses   : ${v.seal.privilege} on ${v.seal.object} to ${v.seal.role}`);
  console.error(`    because   : ${v.seal.why}`);
  console.error(`    declared  : ${v.seal.declaredBy ?? "(unrecorded)"}`);
  console.error("");
}

console.error("If the seal is wrong, change scripts/sealed-grants.json and say why there.");
console.error("Do not change the .sql file to slip past the matcher.");
process.exit(1);
