#!/usr/bin/env node
/**
 * Ordence , MEASURE A QUERY THE WAY THE APPLICATION ACTUALLY RUNS IT
 * Version: v1.82.0-alpha - Infra wave H8 (integration, track H)
 *
 * WHY
 * ---
 * Ordence has never been measured. Not badly measured , not measured.
 * When it is, the obvious way to do it is wrong in a flattering
 * direction, and this exists to make the flattering way impossible.
 *
 * Three ways a measurement lies here:
 *
 *   1. MEASURED WITHOUT ROW LEVEL SECURITY. Every tenant query runs
 *      under a policy, and a policy that calls a function per row can
 *      turn an index scan into something quadratic. Connecting as the
 *      owner or as a superuser skips the policy entirely and produces a
 *      number that has nothing to do with production.
 *   2. MEASURED ON AN EMPTY TABLE. A plan on 40 rows tells you nothing
 *      about 400,000, and the sequential scan that is OPTIMAL at 40 rows
 *      is exactly what kills you later.
 *   3. MEASURED ONCE. The first run pays for a cold cache and tells you
 *      about your disk rather than your query.
 *
 * So this REFUSES to measure as a role that can bypass RLS, WARNS loudly
 * when the tables it touched are small, and runs the query repeatedly,
 * reporting the median rather than the best.
 *
 * 🔴 LOCAL ONLY. `EXPLAIN ANALYZE` EXECUTES THE QUERY. Against production
 * that means a real write for a real INSERT or UPDATE. It refuses any
 * non-local host, and separately refuses anything that is not a SELECT
 * unless you pass --i-know-this-writes.
 *
 * USAGE
 *   PGHOST=127.0.0.1 PGPORT=5602 node scripts/measure-query.mjs \
 *     --db ordence_test --role ordence_app --tenant <uuid> \
 *     --sql "SELECT * FROM invoices WHERE status = 'open'"
 *
 *   ... --file query.sql --runs 7
 *
 * EXIT  0 measured   1 the measurement is not trustworthy   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };

const db = arg("--db");
const role = arg("--role") ?? "ordence_app";
const tenant = arg("--tenant");
const runs = Number(arg("--runs") ?? 5);
const sqlText = arg("--sql");
const sqlFile = arg("--file");
const allowWrites = argv.includes("--i-know-this-writes");

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const ADMIN = process.env.PGUSER ?? "postgres";

if (!db || (!sqlText && !sqlFile)) {
  console.error("usage: measure-query.mjs --db <database> [--role ordence_app] [--tenant <uuid>]");
  console.error("                         (--sql \"…\" | --file q.sql) [--runs 5]");
  process.exit(78);
}

const LOCAL = ["127.0.0.1", "localhost", "::1", "/tmp"];
if (!LOCAL.includes(HOST)) {
  console.error(
    `measure-query , REFUSING. PGHOST is "${HOST}", which is not local.\n` +
    "EXPLAIN ANALYZE EXECUTES the query. Measure against a throwaway copy.",
  );
  process.exit(78);
}
if (spawnSync("which", ["psql"]).status !== 0) { console.error("measure-query , psql is required"); process.exit(78); }

const query = (sqlText ?? fs.readFileSync(sqlFile, "utf8")).trim().replace(/;\s*$/, "");

/**
 * ⚠️ EXPLAIN ANALYZE RUNS THE STATEMENT. A stray UPDATE measured a dozen
 * times is a dozen updates. Refuse by default and make the override
 * unpleasant to type.
 */
if (!/^\s*(select|with)\b/i.test(query) && !allowWrites) {
  console.error(
    "measure-query , REFUSING. This is not a SELECT, and EXPLAIN ANALYZE EXECUTES it.\n" +
    "Measuring an UPDATE five times performs five updates. If you meant it, pass\n" +
    "--i-know-this-writes and do it on a database you can throw away.",
  );
  process.exit(78);
}

const asAdmin = (sql) =>
  spawnSync("psql", ["-h", HOST, "-p", PORT, "-U", ADMIN, "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8" });

if (asAdmin("SELECT 1").status !== 0) { console.error(`measure-query , cannot reach ${db}`); process.exit(78); }

/**
 * 🔴 THE CHECK THAT MAKES THE REST WORTH ANYTHING. A role with BYPASSRLS
 * or SUPERUSER does not see the policies, so every number it produces is
 * about a database the application never talks to.
 */
/**
 * ⚠️ `boolean::text` IS 'true'/'false' IN POSTGRES, NOT 't'/'f'. My first
 * version compared against 't', matched nothing, and cheerfully measured
 * as a SUPERUSER while printing "NOBYPASSRLS" in its own header. The
 * check that makes the whole script worth running was itself the thing
 * that did not run.
 */
const roleRow = asAdmin(
  `SELECT CASE WHEN rolbypassrls THEN 't' ELSE 'f' END || ' ' ||` +
  ` CASE WHEN rolsuper THEN 't' ELSE 'f' END FROM pg_roles` +
  ` WHERE rolname = '${role.replace(/'/g, "''")}'`,
).stdout.trim();
if (!roleRow) { console.error(`measure-query , role "${role}" does not exist on ${db}`); process.exit(78); }
const [bypass, superuser] = roleRow.split(" ");
if (bypass === "t" || superuser === "t") {
  console.error(
    `measure-query , REFUSING to measure as "${role}".\n` +
    `  BYPASSRLS=${bypass}  SUPERUSER=${superuser}\n` +
    "That role does not see row level security, so the plan it produces is not\n" +
    "the plan the application gets. Measure as a NOBYPASSRLS role.",
  );
  process.exit(1);
}

const preamble = tenant
  ? `SELECT set_config('app.current_tenant_id', '${tenant.replace(/'/g, "''")}', false);`
  : "";
if (!tenant) {
  console.log("⚠️ no --tenant given. Tenant policies will match nothing and the query will");
  console.log("   be fast for the least interesting reason. Pass a real tenant id.\n");
}

const asRole = (sql) =>
  spawnSync("psql", ["-h", HOST, "-p", PORT, "-U", role, "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8" });

const first = asRole(`${preamble} EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
if (first.status !== 0) {
  console.error("measure-query , the query failed as " + role + ":");
  console.error(first.stderr.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}

const times = [];
let plan = null;
for (let i = 0; i < Math.max(1, runs); i++) {
  const r = asRole(`${preamble} EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  try {
    const parsed = JSON.parse(r.stdout.trim());
    const p = Array.isArray(parsed) ? parsed[0] : parsed;
    times.push(p["Execution Time"]);
    plan = p;
  } catch {
    console.error("measure-query , could not parse the plan. psql output was:");
    console.error(r.stdout.slice(0, 400));
    process.exit(1);
  }
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];

/** Which relations did the plan touch, and how big are they really? */
const rels = new Set();
(function walk(node) {
  if (!node || typeof node !== "object") return;
  if (node["Relation Name"]) rels.add(node["Relation Name"]);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") walk(v);
  }
})(plan);

console.log(`measure-query , ${db} as ${role} (BYPASSRLS=${bypass}, SUPERUSER=${superuser})`);
console.log(`  runs      ${times.length}`);
console.log(`  median    ${median.toFixed(2)} ms`);
console.log(`  fastest   ${times[0].toFixed(2)} ms      slowest ${times[times.length - 1].toFixed(2)} ms`);
console.log("");

let small = false;
if (rels.size) {
  console.log("  tables touched:");
  for (const r of rels) {
    const n = Number(asAdmin(`SELECT count(*) FROM public."${r}"`).stdout.trim() || 0);
    if (n < 10_000) small = true;
    console.log(`    ${r.padEnd(34)} ${n.toLocaleString()} rows${n < 10_000 ? "   ⚠️ small" : ""}`);
  }
  console.log("");
}

/** The plan shape, flattened. What you actually want to read. */
const nodes = [];
(function shape(node, depth = 0) {
  if (!node || typeof node !== "object") return;
  if (node["Node Type"]) {
    nodes.push(`${"  ".repeat(depth)}${node["Node Type"]}` +
      (node["Relation Name"] ? ` on ${node["Relation Name"]}` : "") +
      (node["Index Name"] ? ` using ${node["Index Name"]}` : "") +
      `  (rows=${node["Actual Rows"] ?? "?"}, loops=${node["Actual Loops"] ?? "?"})`);
  }
  for (const c of node.Plans ?? []) shape(c, depth + 1);
  if (node.Plan) shape(node.Plan, depth);
})(plan);
console.log("  plan:");
for (const n of nodes.slice(0, 30)) console.log("    " + n);

console.log("");
if (small) {
  console.error("⚠️ MEASUREMENT NOT TRUSTWORTHY , at least one table has under 10,000 rows.");
  console.error("   A sequential scan is OPTIMAL at this size and catastrophic at scale, so a");
  console.error("   plan taken here can recommend the opposite of what production needs.");
  console.error("   Seed realistic volume before believing any of the above.");
  process.exit(1);
}
console.log("Measured under row level security, on tables of a size worth measuring.");
