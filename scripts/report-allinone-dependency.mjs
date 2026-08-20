#!/usr/bin/env node
/**
 * Ordence , WHAT IS LOST IF ALL-IN-ONE-SETUP.sql IS SKIPPED
 * Version: v1.82.0-alpha - Infra wave H2 (integration, track H)
 *
 * THE CORRECTION THIS SCRIPT EXISTS BECAUSE OF
 * --------------------------------------------
 * I set out to check whether a database built from the numbered
 * migrations ALONE matches production. It cannot, and the premise was
 * wrong. Applying the 122 numbered files to an empty database refuses
 * 111 of them, because they ALTER tables they do not create.
 *
 * The real build order, which `scripts/bootstrap-test-db.mjs` states
 * plainly, is three steps:
 *
 *     1. drizzle-kit push        creates 55 of the 313 tables
 *     2. ALL-IN-ONE-SETUP.sql    creates the rest, INCLUDING tenants,
 *                                users, roles and audit_logs
 *     3. the numbered files      in order
 *
 * So ALL-IN-ONE is not a legacy artefact to be migrated away from. It is
 * step two of a documented three-step build, and the audit finding
 * "RLS for six tables exists only in ALL-IN-ONE" is better stated as:
 * six protections depend on step two never being skipped.
 *
 * THE RISK, THEREFORE, IS AN OPERATOR SKIPPING STEP TWO.
 * Not a hypothetical: somebody rebuilding under pressure sees a folder
 * of numbered files and a loose setup script and runs the numbered ones.
 * This report says exactly what that costs, by name.
 *
 * It reads files. It needs no database and touches nothing.
 *
 * USAGE   node scripts/check-allinone-dependency.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(import.meta.dirname, "..", "SQL-FILES");
const ALL = path.join(DIR, "ALL-IN-ONE-SETUP.sql");

if (!fs.existsSync(ALL)) {
  console.error("check:allinone , ALL-IN-ONE-SETUP.sql not found");
  process.exit(78);
}

/** Comments and string bodies out, so a CREATE inside dynamic SQL is not a CREATE. */
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

const PATTERNS = [
  ["policy",   /create\s+policy\s+"?([a-z0-9_]+)"?\s+on\s+"?(?:public\.)?([a-z0-9_]+)"?/gi],
  ["trigger",  /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z0-9_]+)"?/gi],
  ["function", /create\s+(?:or\s+replace\s+)?function\s+"?(?:public\.)?([a-z0-9_]+)"?\s*\(/gi],
  ["table",    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi],
  ["forcerls", /alter\s+table\s+"?(?:public\.)?([a-z0-9_]+)"?\s+force\s+row\s+level\s+security/gi],
];

function census(sql) {
  const c = code(sql);
  const set = new Set();
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(c)) !== null) {
      const name = kind === "policy" ? `${m[2].toLowerCase()}.${m[1].toLowerCase()}` : m[1].toLowerCase();
      set.add(`${kind}:${name}`);
    }
  }
  return set;
}

const allInOne = census(fs.readFileSync(ALL, "utf8"));

const numbered = new Set();
for (const f of fs.readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
  for (const x of census(fs.readFileSync(path.join(DIR, f), "utf8"))) numbered.add(x);
}

const onlyThere = [...allInOne].filter((x) => !numbered.has(x)).sort();

const byKind = new Map();
for (const x of onlyThere) {
  const [kind, ...rest] = x.split(":");
  if (!byKind.has(kind)) byKind.set(kind, []);
  byKind.get(kind).push(rest.join(":"));
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ onlyInAllInOne: Object.fromEntries(byKind) }, null, 2));
  process.exit(0);
}

console.log("check:allinone , what exists ONLY in ALL-IN-ONE-SETUP.sql");
console.log("");
console.log("Skipping step two of the build costs you these, by name:");
console.log("");

const ORDER = ["policy", "forcerls", "trigger", "function", "table"];
let protections = 0;
for (const kind of ORDER) {
  const names = byKind.get(kind);
  if (!names || names.length === 0) continue;
  if (kind === "policy" || kind === "forcerls" || kind === "trigger") protections += names.length;
  console.log(`  ${kind} , ${names.length}`);
  for (const n of names.slice(0, 40)) console.log(`      ${n}`);
  if (names.length > 40) console.log(`      … and ${names.length - 40} more`);
  console.log("");
}

if (onlyThere.length === 0) {
  console.log("  nothing. Every object it creates is also created by a numbered file.");
} else {
  console.log(`${onlyThere.length} objects, of which ${protections} are protections`);
  console.log("(a policy, a FORCE row-level-security marker, or a trigger).");
  console.log("");
  console.log("THE BUILD ORDER IS THEREFORE NOT OPTIONAL:");
  console.log("  1. drizzle-kit push        (test and local only, NEVER production)");
  console.log("  2. ALL-IN-ONE-SETUP.sql");
  console.log("  3. the numbered files, in order");
}
