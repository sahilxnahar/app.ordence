#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE TWO-LIVE-TENANT ISOLATION HARNESS
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS IS FOR, AND WHY THE EXISTING CONTROLS DO NOT COVER IT
 * ══════════════════════════════════════════════════════════════════════
 * There are four isolation controls in this repository already, and
 * every one of them checks a DIFFERENT thing from this one:
 *
 *   `scripts/check-rls-coverage.mjs`   reads `pg_class` and `pg_policies`
 *      on a live database and asserts the FACTS — enabled, forced,
 *      policied. It never issues a query as a tenant. A policy can be
 *      present, forced, and wrong.
 *
 *   `scripts/check-sql-completeness.mjs` compares the Drizzle schema
 *      against the SQL files, from the source tree, with no database. It
 *      catches a table nobody wrote a policy for. It cannot catch a
 *      policy that does not do what it says.
 *
 *   `scripts/check-rls-writes.mjs`     EXECUTES, and is the model for
 *      this file — but it builds FOUR representative tables by hand and
 *      proves the four policy SHAPES behave. Four of two hundred and
 *      forty-eight. It is a proof about shapes, not about coverage.
 *
 *   `server/platform/canary.ts`        executes against PRODUCTION on a
 *      schedule, which none of the others do — but against a handful of
 *      named target tables, using a tenant id that belongs to NO
 *      workspace, because it must never touch a real second tenant's
 *      data. It is the only one that runs where it matters and the one
 *      that can prove the least per run.
 *
 * ⭐ THIS ONE IS THE MISSING QUADRANT: TWO LIVE TENANTS, EVERY
 * TENANT-SCOPED TABLE, EVERY RUN. It seeds workspace A and workspace B
 * with real rows, opens a session as B, and then hands B every
 * identifier belonging to A — A's row id, A's tenant id — and requires
 * that B can neither read, count, update, delete, forge nor annex a
 * single one of them. The policies it tests are not written here; they
 * are lifted VERBATIM out of `SQL-FILES/`, so a policy this repository
 * has never written is one this harness cannot invent a passing version
 * of.
 *
 * ⚠️ IT DOES NOT REPLACE THE CANARY AND MUST NOT BE READ AS DOING SO.
 * This runs on a throwaway Postgres built from source. The canary runs
 * on the database holding customers' money. A policy can be perfect here
 * and inert there — that is precisely what `check-rls-writes.mjs`
 * discovered — so the two are complements, and the canary is the one
 * that would notice.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR RULES THAT DECIDE WHETHER THIS IS WORTH HAVING
 * ══════════════════════════════════════════════════════════════════════
 * ① A HARNESS THAT PASSES BECAUSE THE PROBE ROLE BYPASSES RLS IS WORSE
 *    THAN NO HARNESS. It reports INCONCLUSIVE and exits non-zero. It is
 *    never allowed to say "passed" from a connection where the proof is
 *    impossible. `check-rls-writes.mjs` refuses in exactly this way and
 *    this file copies the discipline rather than paraphrasing it.
 *
 * ② EVERY "TENANT B SAW ZERO ROWS" IS PAIRED WITH A POSITIVE CONTROL.
 *    Zero rows from a broken connection, a mistyped table, an empty
 *    table or a tenant id that matches nothing looks IDENTICAL to zero
 *    rows from working isolation. So before B's zero counts for
 *    anything, A must be shown reading its own row and B must be shown
 *    reading its own. A table that fails either control is INCONCLUSIVE
 *    — it is subtracted from the coverage number, never counted as a
 *    pass.
 *
 * ③ IT SKIPS LOUDLY, NEVER SILENTLY. Without `HARNESS_DATABASE_URL` the
 *    executing half prints what it did NOT check and the static half
 *    still runs, so the script is never a complete no-op. Set
 *    `TENANT_ISOLATION_REQUIRE_DB=1` in CI to turn the skip into a
 *    failure — a harness everybody believes is running and is not is the
 *    same defect as no harness, wearing a green tick.
 *
 * ④ COVERAGE IS COUNTED AND PRINTED, INCLUDING THE PART THAT IS MISSING.
 *    The run states "N of M tenant-scoped tables probed", names every
 *    table it could not probe and why, and states plainly that
 *    0 of 622 endpoints are probed, because probing tables is not
 *    probing endpoints and implying otherwise would be the whole point
 *    of this file, inverted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE PART THAT MAKES THE PASS MEAN SOMETHING: IT PROVES, ON
 *     EVERY RUN, THAT IT CAN STILL FAIL
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/harness/tenant-isolation-fixture.sql` builds two tables that
 * are BROKEN ON PURPOSE — one with no row-level security at all, one
 * with ENABLE but no FORCE, which the table owner silently bypasses. The
 * ordinary probe is pointed at both, and both MUST come back reported as
 * leaking. If either comes back clean, the probe has stopped detecting
 * anything and this run fails with a message about the harness rather
 * than about the schema.
 *
 * A harness that has only ever been seen to pass is a harness nobody
 * should trust, and "we tested it once by hand" is not a property of the
 * thing running in CI next month.
 *
 * 🔴 NEVER RUN THIS AGAINST NEON. Same rule as the drills, enforced
 *    twice: once here on the connection string before a client is
 *    opened, and once inside the fixture on `current_database()`, because
 *    a human at a psql prompt does not come through this file.
 *
 *   HARNESS_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/tenantprobe \
 *     node scripts/check-tenant-isolation.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const URL_ENV = process.env.HARNESS_DATABASE_URL;

/** The two workspaces. Fixed so a failure message is greppable. */
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
/** One row each, same ids in every table — unique per table is enough. */
const ROW_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ROW_B = "bbbbbbbb-0000-0000-0000-00000000000b";
/** The id tenant B tries to forge a row under. It must never exist. */
const ROW_FORGED = "cccccccc-0000-0000-0000-00000000000c";

const PROBE_SCHEMA = "tenantprobe";
const PROBE_ROLE = "tenant_probe_app";
const PROBE_PASSWORD = "probe_only_never_neon";

let failures = 0;
let inconclusive = false;
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`   ✅ ${msg}`);

/* ================================================================== */
/* ① THE SOURCE OF TRUTH — PARSED, NEVER RETYPED                       */
/* ================================================================== */

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(rel, out);
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * ⭐ WHAT MAKES A TABLE TENANT-SCOPED IS A `tenant_id` COLUMN, and that
 * is decided in `db/schema/*.ts` because that is what `drizzle-kit push`
 * creates. Same rule as `check-rls-writes.mjs` and
 * `check-sql-completeness.mjs`, deliberately — three gates disagreeing
 * about which tables need protecting is a fourth defect.
 *
 * ⚠️ `plans` and `permissions` are global catalogues with no tenant
 * column and are therefore never in this set. They are not exceptions;
 * they simply do not match.
 */
function tenantScopedTables() {
  const names = new Set();
  for (const file of walk("db/schema")) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(
      /export const (\w+) = pgTable\(\s*"([a-z_0-9]+)"([\s\S]*?)\n\s*\);/g,
    )) {
      if (/tenantId:\s*uuid\("tenant_id"\)/.test(m[3])) names.add(m[2]);
    }
  }
  return [...names].sort();
}

/** Balanced-paren extraction starting at the index of an opening `(`. */
function parenAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * ⚠️ ONE STATEMENT, AND ONLY ONE. Both of the bugs this function fixes
 * were found by RUNNING the harness, not by reading it, and both made it
 * report a table as unprobed rather than wrong — which is the failure
 * direction to prefer, but still a hole in a coverage number.
 *
 * ① A fixed-size window ran past the end of the statement, so
 *    `financial_periods` picked up the `FOR INSERT` belonging to the
 *    NEXT policy in the file and was built as an INSERT policy with a
 *    USING clause, which Postgres refuses outright.
 *
 * ② `SQL-FILES/0079` and `0014` write their policies as CONCATENATED SQL
 *    STRING FRAGMENTS inside `format(...)`:
 *
 *        'CREATE POLICY %I ON %I '
 *        'USING ('
 *        '  (tenant_id = app_current_tenant_id()) '
 *        ') '
 *
 *    Read literally that is not SQL, and three telemetry tables failed
 *    to build. Adjacent fragments are joined ONLY across a newline —
 *    never `''` on one line, which is an ESCAPED QUOTE and appears in
 *    every `NULLIF(current_setting(...), '')` predicate in the tree.
 *    Merging those would corrupt 31 policies into nonsense.
 */
function statementAt(src, index) {
  const raw = src.slice(index, index + 6000);
  const joined = raw.replace(/'[ \t]*\r?\n[ \t]*'/g, "");
  const stops = [";", "\nEND", "\nALTER", "\nDROP", "\nCREATE", "COMMENT ON"]
    .map((s) => {
      const i = joined.indexOf(s, 1);
      return i < 0 ? Infinity : i;
    });
  return joined.slice(0, Math.min(...stops));
}

/**
 * ⭐⭐ THE POLICIES ARE LIFTED OUT OF THE MIGRATIONS, NOT WRITTEN HERE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A SECOND COPY WOULD HAVE BEEN WORSE THAN NO HARNESS
 * ══════════════════════════════════════════════════════════════════════
 * The obvious shape for this file is a hand-written `CREATE POLICY` per
 * table. Two hundred and forty-eight of them, in a file nobody re-reads,
 * kept in step with `SQL-FILES/` by hope. The copy that drifted would be
 * the one being tested — so the harness would go on printing a green
 * tick about a policy the product does not have. That is not a weaker
 * test, it is an actively misleading one.
 *
 * So the predicate text is taken VERBATIM. If a migration ships a policy
 * with a subtly wrong predicate, this harness builds that wrong
 * predicate and the probe catches it. If a migration ships no policy at
 * all, there is nothing to build and the table is reported as
 * unprotected rather than skipped.
 *
 * ⚠️ TWO SPELLINGS OF THE SAME STATEMENT, AND BOTH ARE USED HERE.
 * Roughly half the migrations write `CREATE POLICY x ON t` literally;
 * the rest loop — `FOREACH t IN ARRAY ARRAY['a','b'] LOOP EXECUTE
 * format('CREATE POLICY %I ON %I', ...)`. A parser that read only the
 * literal form would silently miss 90 tables and then report coverage of
 * the 158 it could see AS IF IT WERE ALL OF THEM. Both forms are read,
 * and any table left without a policy is a hard failure below, so the
 * parser cannot fail quietly.
 *
 * ⚠️ ORDER MATTERS AND IS DELIBERATE: `ALL-IN-ONE-SETUP.sql` is the
 * consolidated base an operator pastes first, then the numbered
 * migrations in order, exactly as `SQL-RUN-ORDER-31-TO-44.md` describes.
 * Later files DROP and re-CREATE policies, so the last definition of a
 * given (table, policy name) wins — which is what the database ends up
 * holding.
 */
function migrationFacts() {
  const dir = join(ROOT, "SQL-FILES");
  const files = [
    ...(existsSync(join(dir, "ALL-IN-ONE-SETUP.sql")) ? ["ALL-IN-ONE-SETUP.sql"] : []),
    ...readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort(),
  ];

  /** `${table}.${policy}` → definition. Last write wins, as above. */
  const policies = new Map();
  /** table → { enable, force } */
  const rls = new Map();
  /** Helper functions the predicates call, replayed into the probe schema. */
  const helpers = new Map();
  /**
   * ⚠️ A `DROP POLICY` IN A LATER FILE THAN THE LAST `CREATE` MEANS THE
   * POLICY IS NOT THERE. Every migration in this tree writes DROP then
   * CREATE as a pair, so this is normally inert — but a drop-only
   * migration would otherwise leave this harness building a policy the
   * database does not have, and reporting a pass earned by it.
   */
  const dropped = new Map();
  /**
   * 🔴 ORDER IS (FILE, POSITION IN FILE), NOT "WHICHEVER LOOP RAN
   * FIRST". Counting matches instead cost a run: every `CREATE POLICY`
   * in a file was numbered before every `DROP POLICY` in the SAME file,
   * so the DROP half of the universal `DROP … ; CREATE …` pair looked
   * later than its own CREATE and deleted 199 policies that are really
   * there. The harness then reported almost the whole schema
   * unprotected — loudly wrong, which is the only tolerable kind, but
   * wrong.
   */
  let fileNo = 0;
  const order = (index) => fileNo * 1e7 + index;

  /**
   * `%I` in a looped `format()` is the table; the POLICY NAME beside it
   * is `t || '_tenant_isolation'`, resolved from the format arguments.
   *
   * 🔴 GETTING THIS WRONG IS NOT COSMETIC. A name that does not match
   * makes 0079's replacement policy a SECOND policy alongside 0011's
   * instead of superseding it — and two permissive policies are OR'd, so
   * the harness would test a strictly WIDER predicate than the database
   * has. That direction of error produces false passes.
   */
  const policyName = (spec, table, statement) => {
    if (!spec.includes("%")) return spec;
    const inline = spec.replace(/%\d*\$?I/, "");
    if (inline) return `${table}${inline}`;
    const arg = statement.match(/\|\|\s*'([a-z_]+)'/i);
    return `${table}${arg ? arg[1] : "_policy"}`;
  };

  for (const file of files) {
    fileNo += 1;
    const src = readFileSync(join(dir, file), "utf8");

    /**
     * The `%I` in a looped statement names whichever table the FOREACH
     * is on. Ranges are recorded first so a statement can be resolved
     * back to its loop's table list.
     */
    const loops = [];
    for (const m of src.matchAll(/ARRAY\s*\[([\s\S]*?)\]([\s\S]*?)END LOOP/gi)) {
      loops.push({
        start: m.index,
        end: m.index + m[0].length,
        tables: [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]),
      });
    }
    const loopAt = (i) => loops.find((l) => i >= l.start && i <= l.end);

    for (const m of src.matchAll(
      /CREATE POLICY\s+(%\d*\$?I\w*|\w+)\s+ON\s+(?:public\.)?(%\d*\$?I|\w+)/gi,
    )) {
      const tables = m[2].includes("%") ? (loopAt(m.index)?.tables ?? []) : [m[2]];
      const tail = statementAt(src, m.index);
      const usingIdx = tail.search(/\bUSING\s*\(/i);
      const checkIdx = tail.search(/\bWITH\s+CHECK\s*\(/i);
      const cmd = tail.match(/\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
      const restrictive = /\bAS\s+RESTRICTIVE\b/i.test(tail.slice(0, Math.max(usingIdx, 0) || 200));

      for (const table of tables) {
        const name = policyName(m[1], table, tail);
        policies.set(`${table}.${name}`, {
          table,
          name,
          restrictive,
          cmd: cmd ? cmd[1].toUpperCase() : "ALL",
          using: usingIdx >= 0 ? parenAt(tail, tail.indexOf("(", usingIdx)) : null,
          check: checkIdx >= 0 ? parenAt(tail, tail.indexOf("(", checkIdx)) : null,
          file,
          at: order(m.index),
        });
      }
    }

    for (const m of src.matchAll(
      /DROP POLICY\s+(?:IF EXISTS\s+)?(%\d*\$?I\w*|\w+)\s+ON\s+(?:public\.)?(%\d*\$?I|\w+)/gi,
    )) {
      const tables = m[2].includes("%") ? (loopAt(m.index)?.tables ?? []) : [m[2]];
      const tail = statementAt(src, m.index);
      for (const table of tables) {
        dropped.set(`${table}.${policyName(m[1], table, tail)}`, order(m.index));
      }
    }

    for (const m of src.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?(%\d*\$?I|\w+)\s+(ENABLE|FORCE)\s+ROW LEVEL SECURITY/gi,
    )) {
      const tables = m[1].includes("%") ? (loopAt(m.index)?.tables ?? []) : [m[1]];
      for (const table of tables) {
        const r = rls.get(table) ?? { enable: false, force: false };
        if (m[2].toUpperCase() === "ENABLE") r.enable = true;
        else r.force = true;
        rls.set(table, r);
      }
    }

    /**
     * ⚠️ THE PREDICATES CALL FUNCTIONS, AND THE FUNCTIONS ARE THE
     * MECHANISM. `app_current_tenant_id()` is what turns a session
     * variable into a uuid; `app_platform_scope()` is what widens a read
     * across workspaces. Re-declaring them here would mean testing a
     * predicate against a reimplementation of the thing it depends on —
     * so these are replayed verbatim too.
     */
    for (const m of src.matchAll(
      /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(app_\w+)\s*\(\s*\)([\s\S]*?\$\$;)/gi,
    )) {
      helpers.set(m[1], `CREATE OR REPLACE FUNCTION ${m[1]}()${m[2]}`);
    }
  }

  for (const [key, at] of dropped) {
    if ((policies.get(key)?.at ?? -1) < at) policies.delete(key);
  }

  return { policies: [...policies.values()], rls, helpers };
}

/**
 * ⭐ THE ENDPOINT COUNT IS PRINTED BECAUSE THE GAP MUST BE VISIBLE.
 *
 * ⚠️ THE GUIDELINE ASKS FOR "EVERY ENDPOINT CALLED AS TENANT B USING
 * TENANT A'S IDENTIFIERS". This harness does not do that, and saying so
 * in a number is the only honest way to ship it. Probing tables proves
 * the DATABASE refuses; it proves nothing about a route handler that
 * reads a tenant id out of a request body, or a server action that
 * forgot `withTenant` and used the module-level `db` (which
 * `check-rls-writes.mjs` counts separately, and which is currently zero).
 */
function endpointCount() {
  let handlers = 0;
  let actions = 0;
  for (const file of walk("app")) {
    if (!file.endsWith("/route.ts")) continue;
    const src = readFileSync(join(ROOT, file), "utf8");
    handlers += [...src.matchAll(/^export\s+(?:async\s+)?(?:const|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/gm)]
      .length;
  }
  for (const file of walk("server/actions")) {
    const src = readFileSync(join(ROOT, file), "utf8");
    actions += [...src.matchAll(/^export\s+async\s+function\s+\w+/gm)].length;
  }
  return { handlers, actions, total: handlers + actions };
}

/* ================================================================== */
/* ② THE STATIC HALF — RUNS WITH NO DATABASE                           */
/* ================================================================== */

/**
 * ⭐ PLATFORM-EVIDENCE TABLES ARE OUT OF SCOPE FOR THIS PROBE.
 *
 * The harness seeds every probed table with one row per tenant, then
 * proves tenant B cannot touch tenant A's row. That ownership model
 * does not apply to platform-evidence tables: their write policy is
 * `WITH CHECK app_platform_scope()` — NO tenant session can own a row,
 * ever. The harness insert would legitimately 42501 and crash the run
 * (which is exactly how `login_lockouts` was found: the table landed in
 * the probe list and broke the harness on a correct policy).
 *
 * These tables are not untested: `check-rls-coverage.mjs` demands their
 * boundaries by name (OPT_IN_PLATFORM_WRITE), and `check-rls-writes.mjs`
 * demands that every cross-tenant read in them goes through
 * `withPlatformScope`. Keeping the tenant-ownership harness pointed at
 * them would make the harness RED FOR CORRECTNESS — which is the
 * failure direction a gate must never take.
 *
 * Adding a table here is a visible decision, kept in lockstep with the
 * same named set in `check-rls-coverage.mjs`.
 */
const PLATFORM_EVIDENCE_TABLES = new Set([
  // 0079 opt-in platform-write tables — all platform evidence:
  "error_events",
  "platform_entitlement_history",
  "platform_impersonation_sessions",
  "platform_tenant_flags",
  "security_events",
  "tenant_health_events",
  "web_vital_events",
  // 0089 login lockout evidence — credential-attack counters are
  //      platform evidence: a lockout belongs to no tenant.
  "login_lockouts",
]);

const TABLES = tenantScopedTables().filter((t) => !PLATFORM_EVIDENCE_TABLES.has(t));
const { policies, rls, helpers } = migrationFacts();
const ENDPOINTS = endpointCount();

const policiesFor = (table) => policies.filter((p) => p.table === table);

console.log("\n🔎 check:tenant-isolation\n");
console.log(
  `   ${TABLES.length} tenant-scoped tables in db/schema, ` +
    `${policies.length} policies parsed out of SQL-FILES, ` +
    `${helpers.size} helper functions (${[...helpers.keys()].join(", ")}).`,
);

/**
 * 🔴 A TABLE WITH NO POLICY, NO ENABLE OR NO FORCE FAILS HERE, BEFORE
 * ANY DATABASE IS INVOLVED.
 *
 * ⚠️ It is not enough to leave it out of the probe and mention it in the
 * coverage line. "Not probed" reads as "we did not get to it"; this is
 * "the migrations never protected it", which is the four-table incident
 * `check-rls-coverage.mjs` was written for, visible from the source tree
 * with no live database at all.
 */
const unprotected = [];
for (const table of TABLES) {
  const r = rls.get(table) ?? { enable: false, force: false };
  const missing = [];
  if (policiesFor(table).length === 0) missing.push("no CREATE POLICY anywhere");
  if (!r.enable) missing.push("no ENABLE ROW LEVEL SECURITY");
  if (!r.force) missing.push("no FORCE ROW LEVEL SECURITY");
  if (missing.length > 0) unprotected.push({ table, missing });
}

if (unprotected.length > 0) {
  fail(
    `${unprotected.length} tenant-scoped table(s) are not protected by the migrations. ` +
      `Every tenant can read every other tenant's rows in these:\n` +
      unprotected.map((u) => `      ${u.table} — ${u.missing.join("; ")}`).join("\n"),
  );
} else {
  pass(
    `all ${TABLES.length} tenant-scoped tables are ENABLEd, FORCEd and policied by the migrations`,
  );
}

/* ================================================================== */
/* ③ THE REFUSALS — BEFORE A CLIENT IS EVER OPENED                     */
/* ================================================================== */

/**
 * 🔴 THIS SCRIPT CREATES A LOGIN ROLE AND DROPS A SCHEMA CASCADE. Run
 * against the wrong connection string it is not a failed test, it is an
 * incident.
 *
 * ⚠️ THE `DATABASE_URL` CHECK IS THE ONE THAT MATTERS MOST IN PRACTICE.
 * Nobody types a Neon host into `HARNESS_DATABASE_URL` on purpose; what
 * happens is `HARNESS_DATABASE_URL=$DATABASE_URL` in a shell, because
 * the harness "needs a database" and that is the one that is already
 * exported.
 */
function refuseUnlessThrowaway(raw) {
  const reasons = [];
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return ["HARNESS_DATABASE_URL is not a parseable URL."];
  }
  const host = parsed.hostname.toLowerCase();
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();

  if (/neon\.tech|neon\.build|aws\.neon|azure\.neon/.test(host)) {
    reasons.push(`host "${host}" is Neon.`);
  }
  if (/prod|live/.test(host)) reasons.push(`host "${host}" names an environment.`);
  if (/neon|prod/.test(name) || ["neondb", "ordence", "production", "postgres"].includes(name)) {
    reasons.push(`database "${name}" looks real.`);
  }
  if (process.env.DATABASE_URL && raw === process.env.DATABASE_URL) {
    reasons.push("it is byte-for-byte DATABASE_URL — the application's own database.");
  }
  return reasons;
}

/* ================================================================== */
/* ④ THE EXECUTING HALF                                                */
/* ================================================================== */

/**
 * One tenant-scoped table, reduced to the two columns every policy in
 * this repository actually reads. Nothing else is needed and everything
 * else is a reason for the CREATE to fail.
 *
 * ⚠️ `tenant_id` IS NOT DECLARED NOT NULL, and that is not laziness.
 * Four policies (`payment_events` and friends) are written
 * `(tenant_id = app_current_tenant_id()) OR (tenant_id IS NULL AND ...)`
 * — a NOT NULL here would make half of each of those predicates
 * unreachable and quietly narrow what is being tested.
 */
const tableDdl = (table) => `
  CREATE TABLE ${PROBE_SCHEMA}."${table}" (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid
  );`;

function policyDdl(policy) {
  const parts = [
    `CREATE POLICY "${policy.name}" ON ${PROBE_SCHEMA}."${policy.table}"`,
    policy.restrictive ? "  AS RESTRICTIVE" : null,
    policy.cmd !== "ALL" ? `  FOR ${policy.cmd}` : null,
    policy.using ? `  USING (${policy.using})` : null,
    policy.check ? `  WITH CHECK (${policy.check})` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

async function execute() {
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: URL_ENV });
  await admin.connect();

  /* ---- the fixture: guard, schema, and the two broken controls ---- */
  const fixture = readFileSync(
    join(ROOT, "scripts", "harness", "tenant-isolation-fixture.sql"),
    "utf8",
  );
  await admin.query(fixture);
  await admin.query(`SET search_path = ${PROBE_SCHEMA}, public`);

  /**
   * ⚠️ THE HELPERS GO IN THE PROBE SCHEMA, NOT `public`, and the
   * `search_path` above is what makes the unqualified
   * `app_current_tenant_id()` inside a lifted predicate resolve to them.
   * Postgres resolves the name when the policy is CREATED, so a probe
   * schema that dropped its helpers would not silently fall back to a
   * differently-behaved `public` copy — the CREATE POLICY would fail and
   * the table would be reported unprobed.
   */
  /**
   * ⚠️ A HELPER THAT WILL NOT BUILD IS A NOTE, NOT A FAILURE, AND THE
   * REASON IS SPECIFIC. `app_origin_id()` reads a product table
   * (`installation`) that this minimal fixture does not create, and no
   * tenant-isolation policy calls it. Failing the run on it would make
   * the harness red for something that is not an isolation defect, and a
   * gate that is red for unrelated reasons is a gate people stop
   * reading.
   *
   * ⭐ IT CANNOT HIDE ANYTHING. If a policy DOES call a helper that
   * failed to build, that policy's CREATE fails, and the table lands in
   * `unbuilt` — subtracted from coverage and printed by name.
   */
  const helperNotes = [];
  for (const [name, body] of helpers) {
    try {
      await admin.query(body.replace(/FUNCTION\s+(?:public\.)?app_/i, `FUNCTION ${PROBE_SCHEMA}.app_`));
    } catch (err) {
      helperNotes.push(`${name}() — ${err.message.split("\n")[0]}`);
    }
  }
  if (helperNotes.length > 0) {
    console.log(
      `   ℹ️  ${helperNotes.length} helper(s) not replayed (no isolation policy calls them; ` +
        `any policy that did would show up as an unbuilt table):`,
    );
    for (const note of helperNotes) console.log(`      ${note}`);
  }

  /* ---- build every tenant-scoped table exactly as declared -------- */
  const probed = [];
  const unbuilt = [];

  for (const table of TABLES) {
    try {
      await admin.query(tableDdl(table));
      const r = rls.get(table) ?? { enable: false, force: false };
      /**
       * ⭐ ENABLE AND FORCE ARE APPLIED ONLY IF THE MIGRATIONS SAY SO.
       * Applying FORCE unconditionally would be the harness quietly
       * repairing the exact defect it exists to find — the probe role
       * OWNS these tables, so a table the migrations forgot to FORCE
       * genuinely leaks to it, and that leak is a finding, not a setup
       * error to be smoothed over.
       */
      if (r.enable) await admin.query(`ALTER TABLE ${PROBE_SCHEMA}."${table}" ENABLE ROW LEVEL SECURITY`);
      if (r.force) await admin.query(`ALTER TABLE ${PROBE_SCHEMA}."${table}" FORCE ROW LEVEL SECURITY`);
      for (const policy of policiesFor(table)) await admin.query(policyDdl(policy));
      probed.push(table);
    } catch (err) {
      /**
       * 🔴 A TABLE THAT WILL NOT BUILD IS NOT A TABLE THAT PASSED. It is
       * subtracted from the coverage number and named in the report — a
       * policy referencing a column or a sibling table this minimal
       * fixture does not have would land here, and pretending otherwise
       * is how a coverage figure starts meaning nothing.
       */
      unbuilt.push({ table, reason: err.message.split("\n")[0] });
    }
  }

  /* ---- the deliberately broken controls join the probe list ------- */
  const CONTROLS = ["__broken_no_rls_at_all", "__broken_enabled_not_forced"];

  /**
   * ⭐ SABOTAGE, FOR REPRODUCING A FAILING RUN ON DEMAND.
   *
   * ⚠️ IT ONLY EVER MAKES THE RUN MORE LIKELY TO FAIL, never less, and
   * a sabotaged run that PASSES is itself a hard failure below. A switch
   * that could quieten this harness would be a back door into the one
   * control that proves tenants cannot read each other.
   */
  const sabotage = (process.env.TENANT_ISOLATION_SABOTAGE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const table of sabotage) {
    if (!probed.includes(table)) {
      fail(`TENANT_ISOLATION_SABOTAGE names "${table}", which is not a probed table.`);
      continue;
    }
    await admin.query(`ALTER TABLE ${PROBE_SCHEMA}."${table}" NO FORCE ROW LEVEL SECURITY`);
    console.log(
      `\n🔴 SABOTAGE ACTIVE on "${table}" — FORCE removed, so its owner (the probe\n` +
        `   role) bypasses a policy that still reads as correct. This run MUST FAIL.\n`,
    );
  }

  /* ---- the probe role -------------------------------------------- */
  await admin.query(`
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      END IF;
      /*
       * Only superusers are implicit members of the roles they create.
       * A CREATEROLE-bearing admin (the Neon-safe configuration) must be
       * an explicit member before SET ROLE works; if the admin already
       * has the membership (superuser) this no-ops.
       */
    END $do$;
  `);
  /*
   * Only superusers are implicit members of the roles they create.
   * A CREATEROLE-bearing admin (the Neon-safe configuration) must be
   * an explicit member before SET ROLE works; the grant here can fail
   * only when the admin already holds the membership, in which case
   * failing quietly is exactly right.
   */
  try {
    await admin.query(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
  } catch {
    /* membership already held (superuser admin) — no action needed */
  }
  await admin.query(`GRANT USAGE ON SCHEMA ${PROBE_SCHEMA} TO ${PROBE_ROLE}`);
  /**
   * ⚠️ OWNERSHIP, NOT A GRANT, AND THAT IS THE HARDEST CONFIGURATION TO
   * PASS. `check-rls-coverage.mjs` records why: "the app connects as the
   * table owner on Neon". An owner is exempt from its own table's
   * policies unless the table is FORCEd, so testing as the owner is the
   * only way FORCE is load-bearing. A non-owner probe would pass on a
   * table that leaks in production.
   */
  for (const table of [...probed, ...CONTROLS]) {
    await admin.query(`ALTER TABLE ${PROBE_SCHEMA}."${table}" OWNER TO ${PROBE_ROLE}`);
  }

  /* ---- seed two live tenants ------------------------------------- */
  /**
   * ⭐ SEEDED BY THE ADMIN CONNECTION, ON PURPOSE. If the rows were
   * written through the mechanism under test, a policy that refused
   * every write would leave both tables empty and every subsequent
   * "tenant B saw zero rows" would pass for the wrong reason. The seed
   * must not share a failure mode with the assertion.
   */
  for (const table of [...probed, ...CONTROLS]) {
    await admin.query(
      `INSERT INTO ${PROBE_SCHEMA}."${table}" (id, tenant_id) VALUES ($1, $2), ($3, $4)`,
      [ROW_A, TENANT_A, ROW_B, TENANT_B],
    );
  }

  /* ---- connect as the role the deploy checklist demands ----------- */
  const url = new URL(URL_ENV);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  const app = new pg.Client({ connectionString: url.toString() });
  await app.connect();
  await app.query(`SET search_path = ${PROBE_SCHEMA}, public`);

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 RULE ①, AND IT IS THE MOST IMPORTANT LINE IN THE FILE
   * ══════════════════════════════════════════════════════════════════
   * If this role can bypass row-level security, then every assertion
   * below is a statement about nothing. It would not merely be a weak
   * pass — a bypassing role SEES the other tenant's rows, so the run
   * would go red, and the obvious way to quieten a red run is to narrow
   * the probe until it stops returning rows. That "fix" produces a green
   * tick on a connection where policies are not evaluated at all, and it
   * is then believed. `server/platform/canary.ts` sets out that trap at
   * length; this is the same trap and the same refusal.
   *
   * ⭐ INCONCLUSIVE. NOT A PASS WITH A WARNING. The process exits
   * non-zero and prints no coverage figure, because a coverage figure
   * earned this way is worse than none.
   */
  const priv = await app.query(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (priv.rows[0]?.rolsuper || priv.rows[0]?.rolbypassrls) {
    inconclusive = true;
    fail(
      `INCONCLUSIVE — the probe role "${PROBE_ROLE}" is ` +
        `${priv.rows[0].rolsuper ? "a SUPERUSER" : "BYPASSRLS"}. ` +
        `Nothing below could have failed, so nothing below is evidence. ` +
        `This harness reports INCONCLUSIVE rather than a pass, always.`,
    );
    await app.end();
    await admin.end();
    return { probed: [], unbuilt, controls: [], leaks: [], inconclusiveTables: [] };
  }
  pass(`probe connects as "${PROBE_ROLE}" — not a superuser, not BYPASSRLS`);

  /* ================================================================ */
  /* THE PROBE ITSELF                                                  */
  /* ================================================================ */

  /**
   * Ten assertions per table. Six of them are tenant B being handed
   * tenant A's identifiers; two are the positive controls that make
   * B's zeroes mean something; two are B's own rows still working,
   * because isolation that also breaks the tenant is not isolation.
   *
   * ⚠️ THE WRITE PROBES COMMIT. A `ROLLBACK` would make the aftermath
   * check vacuous — of course A's row survives a transaction that was
   * thrown away. They are supposed to be no-ops; committing is what
   * proves they were.
   */
  const scoped = async (tenant, body) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
      const result = await body();
      await app.query("COMMIT");
      return result;
    } catch (err) {
      await app.query("ROLLBACK").catch(() => {});
      throw err;
    }
  };

  const q = (table) => `${PROBE_SCHEMA}."${table}"`;

  async function probe(table) {
    const problems = [];
    const blocked = [];

    /* ---- POSITIVE CONTROL: A reads its own row ------------------- */
    let controlA;
    try {
      controlA = await scoped(TENANT_A, () =>
        app.query(`SELECT count(*)::int AS n FROM ${q(table)} WHERE id = $1`, [ROW_A]),
      );
    } catch (err) {
      return { control: `tenant A could not read at all: ${err.message.split("\n")[0]}` };
    }
    if (controlA.rows[0].n !== 1) {
      /**
       * 🔴 RULE ②. A table whose owner cannot see its own row proves
       * nothing when tenant B also sees nothing. Two real tables land
       * here by design — their policy is `app_platform_scope()` only,
       * so no tenant session reads them — and they are reported as
       * INCONCLUSIVE rather than counted as isolated.
       */
      return { control: `tenant A cannot read its OWN row (got ${controlA.rows[0].n}, expected 1)` };
    }

    /* ---- POSITIVE CONTROL: B reads its own row ------------------- */
    const controlB = await scoped(TENANT_B, () =>
      app.query(`SELECT count(*)::int AS n FROM ${q(table)} WHERE id = $1`, [ROW_B]),
    );
    if (controlB.rows[0].n !== 1) {
      return { control: `tenant B cannot read its OWN row (got ${controlB.rows[0].n}, expected 1)` };
    }

    /* ---- THE ISOLATION PROBES: B, holding A's identifiers -------- */
    await scoped(TENANT_B, async () => {
      const byRowId = await app.query(
        `SELECT count(*)::int AS n FROM ${q(table)} WHERE id = $1`,
        [ROW_A],
      );
      if (byRowId.rows[0].n !== 0) problems.push(`read A's row BY A's ROW ID (${byRowId.rows[0].n} rows)`);
      else blocked.push("read by A's row id");

      const byTenantId = await app.query(
        `SELECT count(*)::int AS n FROM ${q(table)} WHERE tenant_id = $1`,
        [TENANT_A],
      );
      if (byTenantId.rows[0].n !== 0)
        problems.push(`read A's rows BY A's TENANT ID (${byTenantId.rows[0].n} rows)`);
      else blocked.push("read by A's tenant id");

      /**
       * ⚠️ THE UNFILTERED READ IS THE ONE THAT CATCHES A POLICY THAT IS
       * NOT THERE AT ALL. A `WHERE` clause the application wrote can
       * make the two probes above return zero on a table with no policy
       * whatsoever; `SELECT count(*)` with no predicate cannot.
       */
      const all = await app.query(`SELECT count(*)::int AS n FROM ${q(table)}`);
      if (all.rows[0].n !== 1)
        problems.push(`an unfiltered read returned ${all.rows[0].n} rows; B owns exactly 1`);
      else blocked.push("unfiltered read sees only B's own row");

      const updated = await app.query(
        `UPDATE ${q(table)} SET tenant_id = tenant_id WHERE id = $1`,
        [ROW_A],
      );
      if (updated.rowCount !== 0) problems.push(`UPDATEd A's row (${updated.rowCount} rows)`);
      else blocked.push("update of A's row");

      const deleted = await app.query(`DELETE FROM ${q(table)} WHERE id = $1`, [ROW_A]);
      if (deleted.rowCount !== 0) problems.push(`DELETEd A's row (${deleted.rowCount} rows)`);
      else blocked.push("delete of A's row");
    });

    /**
     * ⭐ TWO WRITES THAT MUST RAISE 42501, EACH IN ITS OWN TRANSACTION
     * because an error aborts the one it is in.
     *
     * 🔴 THE SECOND IS THE ANNEXATION ATTEMPT, and it is the one a
     * `USING`-only policy misses. B owns the row it is updating, so
     * `USING` permits the update; only `WITH CHECK` stops B stamping
     * tenant A's id onto it and walking the row across the boundary.
     * `SQL-FILES/0006` calls this out for `documents` and installs a
     * trigger as well; this proves the policy half.
     */
    const mustRefuse = async (label, sql, values) => {
      try {
        await scoped(TENANT_B, () => app.query(sql, values));
        problems.push(label);
      } catch (err) {
        if (err.code === "42501") blocked.push(label.replace(/^/, "refused: "));
        else problems.push(`${label} — and failed with ${err.code ?? "?"} rather than 42501`);
      }
    };

    await mustRefuse(
      "INSERTed a row carrying A's tenant id",
      `INSERT INTO ${q(table)} (id, tenant_id) VALUES ($1, $2)`,
      [ROW_FORGED, TENANT_A],
    );
    await mustRefuse(
      "MOVED its own row into tenant A",
      `UPDATE ${q(table)} SET tenant_id = $1 WHERE id = $2`,
      [TENANT_A, ROW_B],
    );

    /* ---- AFTERMATH: A's row is still there, still A's ------------ */
    /**
     * ⭐ `rowCount === 0` FROM THE UPDATE AND DELETE ABOVE IS NOT PROOF
     * ON ITS OWN. It is what Postgres reports when a policy filtered the
     * rows out — and it is also what a driver would report if something
     * else went wrong. Reading the row back as tenant A, after the
     * writes COMMITTED, is the check that cannot be satisfied by an
     * accident.
     */
    const after = await scoped(TENANT_A, () =>
      app.query(
        `SELECT count(*)::int AS n FROM ${q(table)} WHERE id = $1 AND tenant_id = $2`,
        [ROW_A, TENANT_A],
      ),
    );
    if (after.rows[0].n !== 1) problems.push("A's row did not survive B's writes intact");
    else blocked.push("A's row intact afterwards");

    const forged = await scoped(TENANT_A, () =>
      app.query(`SELECT count(*)::int AS n FROM ${q(table)} WHERE id = $1`, [ROW_FORGED]),
    );
    if (forged.rows[0].n !== 0) problems.push("B's forged row landed in tenant A's data");
    else blocked.push("no forged row in A's data");

    return { problems, blocked };
  }

  /* ---- ⭐⭐ THE MUTATION CONTROL, RUN FIRST ---------------------- */
  /**
   * 🔴 IF THE BROKEN TABLES COME BACK CLEAN, EVERY CLEAN RESULT BELOW IS
   * MEANINGLESS AND THE RUN FAILS ON THE HARNESS RATHER THAN THE SCHEMA.
   */
  console.log("\n⭐ MUTATION CONTROL — two tables that are broken on purpose\n");
  const controlResults = [];
  for (const table of CONTROLS) {
    const r = await probe(table);
    const detected = (r.problems?.length ?? 0) > 0;
    controlResults.push({ table, detected, problems: r.problems ?? [] });
    if (detected) {
      pass(`${table} — probe reported ${r.problems.length} leak(s), so it still detects`);
    } else {
      fail(
        `THE HARNESS IS BROKEN: ${table} is deliberately unisolated and the probe ` +
          `reported it clean${r.control ? ` (${r.control})` : ""}. Every green result in ` +
          `this run is therefore evidence of nothing.`,
      );
    }
  }

  /* ---- the real tables ------------------------------------------- */
  console.log(`\n🔴 TENANT B, HOLDING TENANT A'S IDENTIFIERS, ON ${probed.length} TABLES\n`);
  const leaks = [];
  const inconclusiveTables = [];
  let assertions = 0;

  for (const table of probed) {
    const r = await probe(table);
    if (r.control) {
      inconclusiveTables.push({ table, reason: r.control });
      continue;
    }
    assertions += r.problems.length + r.blocked.length;
    if (r.problems.length > 0) leaks.push({ table, problems: r.problems });
  }

  if (leaks.length === 0) {
    pass(
      `${probed.length - inconclusiveTables.length} tables: B could not read, count, ` +
        `update, delete, forge or annex a single row of A's — ${assertions} assertions`,
    );
  } else {
    for (const leak of leaks) {
      fail(
        `🔴 CROSS-TENANT LEAK on "${leak.table}": tenant B ${leak.problems.join("; ")}. ` +
          `Row-level security is the ONLY tenant boundary in this product.`,
      );
    }
  }

  await app.end();
  /**
   * ⚠️ The schema goes; the ROLE stays. Dropping a login role that a
   * concurrent run is connected as fails noisily halfway through, and it
   * owns nothing once the schema is gone.
   */
  await admin.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`).catch(() => {});
  await admin.end();

  return { probed, unbuilt, controls: controlResults, leaks, inconclusiveTables };
}

/* ================================================================== */
/* MAIN                                                                */
/* ================================================================== */

let ran = null;

if (!URL_ENV) {
  /**
   * 🔴 RULE ③. THE SKIP IS LOUD, NAMED, AND OPTIONALLY FATAL.
   *
   * ⚠️ A harness that no-ops quietly in CI is one everybody believes is
   * running — the same shape of defect as the four unprotected tables
   * that shipped past a floor check. The message says exactly what was
   * not checked, and `TENANT_ISOLATION_REQUIRE_DB=1` turns the skip into
   * a failure wherever a database is supposed to exist.
   */
  console.log(
    `\n⏭️  EXECUTING HALF SKIPPED — no HARNESS_DATABASE_URL.\n` +
      `   NOT CHECKED: that tenant B, holding tenant A's row ids and tenant id,\n` +
      `   is actually refused a read, a count, an update, a delete, a forged\n` +
      `   INSERT and an attempt to move its own row into A — on any of the\n` +
      `   ${TABLES.length} tenant-scoped tables. The static half above read the migrations;\n` +
      `   this half is the only thing that runs them.\n` +
      `   Set HARNESS_DATABASE_URL against a THROWAWAY Postgres. NEVER NEON.\n` +
      `   Set TENANT_ISOLATION_REQUIRE_DB=1 to make this skip a failure.\n`,
  );
  if (process.env.TENANT_ISOLATION_REQUIRE_DB) {
    fail(
      "TENANT_ISOLATION_REQUIRE_DB is set and there is no HARNESS_DATABASE_URL. " +
        "The isolation harness did not run.",
    );
  }
} else {
  const reasons = refuseUnlessThrowaway(URL_ENV);
  if (reasons.length > 0) {
    fail(
      `🔴 REFUSING TO RUN: ${reasons.join(" ")} This script CREATEs a role and DROPs a ` +
        `schema CASCADE. Point HARNESS_DATABASE_URL at a throwaway Postgres.`,
    );
  } else {
    ran = await execute();
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ RULE ④ — COVERAGE, INCLUDING THE PART THAT IS MISSING            */
/* ------------------------------------------------------------------ */

if (ran && !inconclusive) {
  const probedCount = ran.probed.length - ran.inconclusiveTables.length;
  console.log(`\n📊 COVERAGE\n`);
  console.log(
    `   ${probedCount} of ${TABLES.length} tenant-scoped tables probed with two live tenants.`,
  );

  if (ran.inconclusiveTables.length > 0) {
    /**
     * ⚠️ INCONCLUSIVE IS PRINTED, NEVER FOLDED INTO THE PASS. These are
     * tables where the positive control did not hold, so "B saw nothing"
     * is not evidence about them. Two are expected — their policy is
     * `app_platform_scope()` only, so no tenant session reads them at
     * all — and expected is not the same as covered.
     */
    console.log(
      `   ${ran.inconclusiveTables.length} INCONCLUSIVE (positive control failed — not counted as isolated):`,
    );
    for (const t of ran.inconclusiveTables) console.log(`      ${t.table} — ${t.reason}`);
  }
  if (ran.unbuilt.length > 0) {
    console.log(`   ${ran.unbuilt.length} could not be built in the probe schema:`);
    for (const t of ran.unbuilt) console.log(`      ${t.table} — ${t.reason}`);
  }

  /**
   * 🔴 THE HONEST SENTENCE. The guideline this harness comes from asks
   * for every ENDPOINT called as tenant B with tenant A's identifiers.
   * This proves the DATABASE refuses; it does not call one route handler
   * or one server action. Stating the number is the difference between a
   * known gap and an implied claim.
   */
  console.log(
    `\n   0 of ${ENDPOINTS.total} endpoints probed ` +
      `(${ENDPOINTS.handlers} HTTP route handlers, ${ENDPOINTS.actions} server actions).\n` +
      `   ⚠️ ENDPOINTS ARE THE NEXT STEP, AND THEY ARE NOT COVERED HERE. This proves\n` +
      `   the database refuses tenant B. It does not prove a route handler passes the\n` +
      `   caller's tenant id rather than the request's, and no count of tables can.\n`,
  );
}

/* ------------------------------------------------------------------ */

if (ran && process.env.TENANT_ISOLATION_SABOTAGE && failures === 0) {
  /**
   * 🔴 A SABOTAGED RUN THAT PASSES IS THE WORST OUTCOME THIS FILE HAS.
   * It means the probe cannot see a table whose FORCE was removed — the
   * precise defect it was written for — and every clean run before it
   * was luck.
   */
  fail(
    `TENANT_ISOLATION_SABOTAGE was set and the run PASSED. The probe did not notice ` +
      `deliberately broken isolation, so it would not notice real breakage either.`,
  );
}

if (failures === 0) {
  console.log(`\n✅ check:tenant-isolation passed.\n`);
  process.exit(0);
}

if (inconclusive) {
  console.error(
    `\n⚠️  check:tenant-isolation INCONCLUSIVE — it proved nothing and says so ` +
      `rather than reporting a pass.\n`,
  );
  process.exit(1);
}

console.error(
  `\n❌ check:tenant-isolation FAILED — ${failures} problem${failures === 1 ? "" : "s"}.\n`,
);
process.exit(1);
