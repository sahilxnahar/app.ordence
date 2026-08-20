#!/usr/bin/env node
/**
 * Ordence , RESTORE DRILL: DOES A REBUILT DATABASE CARRY EVERY PROTECTION?
 * Version: v1.82.0-alpha - Infra wave H7 (integration, track H)
 *
 * WHY
 * ---
 * Nobody has ever restored this database. The moment you need to is the
 * moment you cannot afford to be learning it, and the failure is not
 * "the restore did not work" , a restore almost always produces a
 * database. The failure is a database that LOOKS right and is missing
 * some of the twenty-three protections that live in
 * `ALL-IN-ONE-SETUP.sql` and nowhere else, or a policy that a migration
 * created and a later one dropped.
 *
 * ⚠️ THE EXPECTATIONS ARE COMPUTED FROM THE FILES, NOT WRITTEN DOWN.
 * A hardcoded "expect at least 300 policies" is the exact defect this
 * repository has shipped repeatedly: 0014's impersonation check said
 * `count(*) >= 10 THEN 'PASS'` and passed at 48 of 303. So this reads
 * every SQL file, works out which named policies, triggers and functions
 * SHOULD exist, and names the ones that do not.
 *
 * 🔴 LOCAL ONLY. It reads a database; it does not write one. But it is a
 * drill, and a drill pointed at production is how drills stop being safe.
 * It refuses any non-local host before connecting.
 *
 * USAGE
 *   PGHOST=127.0.0.1 PGPORT=5602 PGUSER=postgres \
 *     node scripts/drill-rebuild.mjs --db ordence_test
 *
 * EXIT  0 every expected protection is present   1 something is missing
 *       78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DIR = path.join(ROOT, "SQL-FILES");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };

const db = arg("--db");
const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const USER = process.env.PGUSER ?? "postgres";

if (!db) { console.error("usage: drill-rebuild.mjs --db <database>  [PGHOST/PGPORT/PGUSER via env]"); process.exit(78); }

const LOCAL = ["127.0.0.1", "localhost", "::1", "/tmp"];
if (!LOCAL.some((l) => HOST.startsWith(l))) {
  console.error(
    `drill-rebuild , REFUSING. PGHOST is "${HOST}", which is not local.\n` +
    "This is a drill. Point it at a throwaway PostgreSQL, never at Neon.",
  );
  process.exit(78);
}
if (spawnSync("which", ["psql"]).status !== 0) { console.error("drill-rebuild , psql is required"); process.exit(78); }

const psql = (args) => spawnSync("psql", ["-h", HOST, "-p", PORT, "-U", USER, "-d", db, "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
if (psql(["-tAc", "SELECT 1"]).status !== 0) {
  console.error(`drill-rebuild , cannot reach ${db} at ${HOST}:${PORT}`);
  process.exit(78);
}

/** Comments and string bodies out, so a CREATE in dynamic SQL is not a CREATE. */
function code(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) { i = sql.indexOf("\n", i); if (i === -1) break; out += "\n"; continue; }
    if (sql.startsWith("/*", i)) { const e = sql.indexOf("*/", i); i = e === -1 ? sql.length : e + 1; continue; }
    if (sql[i] === "'") { const e = sql.indexOf("'", i + 1); i = e === -1 ? sql.length : e; out += "''"; continue; }
    out += sql[i];
  }
  return out;
}

/**
 * DROPS ARE SUBTRACTED, AND ORDER IS TEXTUAL, NOT LOOP ORDER.
 *
 * A policy created by 0003 and dropped by 0079 must not be reported as
 * missing: the noise makes the real answers unreadable, which is how a
 * checker gets switched off. And a DROP followed by a CREATE inside one
 * file is normal, because `CREATE OR REPLACE` cannot change a return type
 * and several migrations drop and recreate.
 *
 * MY FIRST VERSION RAN ALL THE CREATE REGEXES AND THEN ALL THE DROP
 * REGEXES PER FILE, so within any file the drop always won regardless of
 * where it sat in the text. Expected policies came out at 2 against 313
 * present, and it printed RESTORE COMPLETE. That is a floor dressed as a
 * census, the precise defect this script exists to prevent, and it
 * survived until the numbers were read rather than the exit code.
 *
 * Events therefore carry their character offset and are applied in
 * (file, offset) order.
 */
const PATTERNS = [
  ["policy", "create", /create\s+policy\s+"?([a-z0-9_]+)"?\s+on\s+"?(?:public\.)?([a-z0-9_]+)"?/gi],
  ["policy", "drop", /drop\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+"?(?:public\.)?([a-z0-9_]+)"?/gi],
  ["trigger", "create", /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z0-9_]+)"?/gi],
  ["trigger", "drop", /drop\s+trigger\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/gi],
  ["function", "create", /create\s+(?:or\s+replace\s+)?function\s+"?(?:public\.)?([a-z0-9_]+)"?\s*\(/gi],
  ["function", "drop", /drop\s+function\s+(?:if\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi],
];

const files = [
  ...fs.readdirSync(DIR).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort(),
  ...(fs.existsSync(path.join(DIR, "ALL-IN-ONE-SETUP.sql")) ? ["ALL-IN-ONE-SETUP.sql"] : []),
];

const events = [];
files.forEach((f, fileIdx) => {
  const c = code(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const [kind, action, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(c)) !== null) {
      const name = kind === "policy"
        ? `${m[2].toLowerCase()}.${m[1].toLowerCase()}`
        : m[1].toLowerCase();
      events.push({ fileIdx, at: m.index, kind, action, name });
    }
  }
});
events.sort((a, b) => a.fileIdx - b.fileIdx || a.at - b.at);

const expected = { policy: new Set(), trigger: new Set(), function: new Set() };
for (const e of events) {
  if (e.action === "create") expected[e.kind].add(e.name);
  else expected[e.kind].delete(e.name);
}

/**
 * A census that expects far fewer objects than exist is not a census, it
 * is a floor. Refuse rather than report a comfortable zero.
 */
if (expected.policy.size < 50 || expected.trigger.size < 50) {
  console.error(
    `drill-rebuild , REFUSING. Parsed only ${expected.policy.size} policies and ` +
    `${expected.trigger.size} triggers from ${files.length} files. The parse is broken; ` +
    "reporting \"nothing missing\" from this would be worse than reporting nothing.",
  );
  process.exit(78);
}


const rows = (sql) => {
  const r = psql(["-tAc", sql]);
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
};

const actual = {
  policy: rows("SELECT tablename || '.' || policyname FROM pg_policies WHERE schemaname='public'"),
  trigger: rows("SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal"),
  function: rows("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"),
};

const forceOn = rows("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity");
const rlsOn = rows("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity");

console.log(`drill-rebuild , ${db} on ${HOST}:${PORT}`);
console.log(`  expectations computed from ${files.length} SQL file(s), not written down`);
console.log("");

let missingTotal = 0;
for (const kind of ["policy", "trigger", "function"]) {
  const missing = [...expected[kind]].filter((n) => !actual[kind].has(n)).sort();
  missingTotal += missing.length;
  console.log(`  ${kind.padEnd(9)} expected ${String(expected[kind].size).padStart(4)}   present ${String(actual[kind].size).padStart(4)}   missing ${missing.length}`);
  for (const n of missing.slice(0, 25)) console.log(`      - ${n}`);
  if (missing.length > 25) console.log(`      … and ${missing.length - 25} more`);
}

console.log("");
console.log(`  row level security enabled on ${rlsOn.size} table(s), FORCED on ${forceOn.size}`);
const enabledNotForced = [...rlsOn].filter((t) => !forceOn.has(t));
if (enabledNotForced.length) {
  console.log(`  ⚠️ ${enabledNotForced.length} table(s) have RLS ENABLED but not FORCED.`);
  console.log("     Production connects as the table OWNER, and an owner is not subject");
  console.log("     to ENABLE. Only FORCE applies to it. On those tables the policy is");
  console.log("     decorative for the running application.");
  for (const t of enabledNotForced.slice(0, 20)) console.log(`      - ${t}`);
  if (enabledNotForced.length > 20) console.log(`      … and ${enabledNotForced.length - 20} more`);
}

console.log("");
if (missingTotal > 0) {
  console.error(`RESTORE INCOMPLETE , ${missingTotal} named protection(s) absent.`);
  console.error("A database that is missing these will run, serve pages, and pass a smoke test.");
  process.exit(1);
}
console.log("RESTORE COMPLETE , every policy, trigger and function the files create is present.");
