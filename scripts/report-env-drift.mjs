#!/usr/bin/env node
/**
 * Ordence , DOES THE DEPLOYMENT ACTUALLY HAVE THE SETTINGS IT NEEDS?
 * Version: v1.82.0-alpha - Infra wave H6 (integration, track H)
 *
 * WHY
 * ---
 * `check:env-catalogue` proves the catalogue and the code agree with each
 * other. Both can be perfect while the RUNNING deployment is missing a
 * name entirely, and that failure presents as a deploy that builds, ships
 * an image, starts, and dies with an empty log. We have had exactly that
 * once already and it took a day to attribute.
 *
 * This compares the catalogue against the names a deployment actually
 * has.
 *
 * 🔴 IT NEVER READS A VALUE, AND CANNOT. It takes a list of NAMES, one
 * per line. That is a deliberate limit, not an inconvenience: a tool that
 * reads production secrets is a tool that can leak them, and every
 * question worth asking here is answerable from names alone.
 *
 * Get the names without exposing values:
 *
 *     railway variables --json | jq -r 'keys[]' > /tmp/have.txt
 *
 * or copy the `variableNames` list out of the Railway service config.
 *
 * WHAT IT REPORTS
 *   REQUIRED and absent   , the deployment will fail, probably silently
 *   optional and absent   , a feature is off; usually fine, sometimes not
 *   present, uncatalogued , somebody set something nobody documented
 *
 * USAGE
 *   node scripts/report-env-drift.mjs --have /tmp/have.txt
 *   node scripts/report-env-drift.mjs --have /tmp/have.txt --json
 *
 * EXIT  0 nothing required is missing   1 something is   78 EX_CONFIG
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const have = arg("--have");

if (!have) {
  console.error("usage: check-env-drift.mjs --have <file of NAMES, one per line> [--json]");
  console.error("  railway variables --json | jq -r 'keys[]' > /tmp/have.txt");
  process.exit(78);
}
if (!fs.existsSync(have)) { console.error("env:drift , no such file: " + have); process.exit(78); }

const raw = fs.readFileSync(have, "utf8");
/**
 * ⚠️ REFUSE A FILE THAT LOOKS LIKE IT CONTAINS VALUES. If somebody pastes
 * `KEY=secret` instead of `KEY`, this tool must not quietly accept it and
 * keep a copy of production secrets in a temp file it then reads.
 */
const looksLikeValues = raw.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*\s*=\s*\S/.test(l.trim()));
if (looksLikeValues.length > 0) {
  console.error(
    `env:drift , REFUSING. ${looksLikeValues.length} line(s) look like NAME=value.\n` +
    "This tool takes names only. Strip the values before running it:\n" +
    "  cut -d= -f1 < yourfile > /tmp/have.txt",
  );
  process.exit(78);
}

const present = new Set(raw.split("\n").map((s) => s.trim()).filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s)));
if (present.size === 0) { console.error("env:drift , no names found in " + have); process.exit(78); }

/**
 * Parsed from source, like every other gate here: a .mjs script cannot
 * import TypeScript without a build step. The parse is per-category so
 * `required` and `optional` stay distinguishable , which is the entire
 * point, since treating them alike would either cry wolf about optional
 * AI keys or stay silent about a missing DATABASE_URL.
 */
const src = fs.readFileSync(path.join(ROOT, "lib", "platform", "env-catalog.ts"), "utf8");
const body = src.slice(src.indexOf("export const ENV_CATEGORIES"));

function namesIn(listName) {
  const out = new Set();
  const re = new RegExp(listName + "\\s*:\\s*\\[", "g");
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === "[") depth++;
      else if (body[i] === "]") depth--;
    }
    const chunk = body.slice(m.index + m[0].length, i);
    for (const q of chunk.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) out.add(q[1]);
  }
  return out;
}

const required = namesIn("required");
const optional = namesIn("optional");
for (const r of required) optional.delete(r);

if (required.size === 0) {
  console.error("env:drift , parsed zero required names. The catalogue moved; fix the parse.");
  process.exit(78);
}

const requiredMissing = [...required].filter((n) => !present.has(n)).sort();
const optionalMissing = [...optional].filter((n) => !present.has(n)).sort();
const uncatalogued = [...present].filter((n) => !required.has(n) && !optional.has(n)).sort();

if (argv.includes("--json")) {
  console.log(JSON.stringify({ requiredMissing, optionalMissing, uncatalogued,
    counts: { required: required.size, optional: optional.size, present: present.size } }, null, 2));
  process.exit(requiredMissing.length ? 1 : 0);
}

console.log("env:drift , catalogue versus what the deployment has");
console.log(`  ${required.size} required, ${optional.size} optional, ${present.size} set`);
console.log("");

if (requiredMissing.length) {
  console.error("  🔴 REQUIRED AND NOT SET , the deployment will fail, probably with an empty log:");
  for (const n of requiredMissing) console.error(`      ${n}`);
  console.error("");
}

if (optionalMissing.length) {
  console.log(`  ${optionalMissing.length} optional and not set , each one is a feature that is OFF.`);
  console.log("  Read the list; some of these are only optional in the sense that the app starts.");
  for (const n of optionalMissing) console.log(`      ${n}`);
  console.log("");
}

if (uncatalogued.length) {
  console.log("  set but not catalogued , somebody configured something nobody documented:");
  for (const n of uncatalogued) console.log(`      ${n}`);
  console.log("");
}

if (requiredMissing.length === 0 && optionalMissing.length === 0 && uncatalogued.length === 0) {
  console.log("  no drift.");
}

process.exit(requiredMissing.length ? 1 : 0);
