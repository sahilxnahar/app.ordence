#!/usr/bin/env node
/**
 * Ordence , CROSS-CHECK A TRACK REPORT AGAINST WHAT IT ACTUALLY SHIPPED
 * Version: v1.82.0-alpha - Infra wave H5 (integration, track H)
 *
 * WHY
 * ---
 * Seven reports will arrive at once, each a few thousand words, each
 * confident. Reading them is not verification: a report is a claim about
 * a zip, and the zip is right there. The cheap half of checking can be
 * mechanical, which leaves the expensive half , actually disproving the
 * interesting claims , with more attention to spend on it.
 *
 * WHAT IT COMPARES
 *   1. Files the report NAMES but the zip does not contain.
 *      "Added `lib/foo/bar.ts`" with no such file is the single most
 *      likely way a report and a delivery disagree.
 *   2. Files the zip CONTAINS that the report never mentions.
 *      Undocumented changes are how a surprise reaches production.
 *   3. Migration numbers named versus migration files delivered.
 *   4. Whether the report contains EVIDENCE at all , commands, outputs,
 *      counts , rather than only assertions.
 *
 * ⚠️ WHAT IT DOES NOT DO, AND MUST NOT BE READ AS DOING. It cannot tell
 * you whether a claim is TRUE. A report can pass every check here and be
 * wrong about everything that matters. This narrows where to look; it
 * does not decide. Treating a green run as acceptance would be exactly
 * the verified-by-a-floor mistake this project keeps making.
 *
 * USAGE
 *   node scripts/verify-report.mjs --zip ordence-track-A.zip
 *   node scripts/verify-report.mjs --zip … --since ordence-track-A-prev.zip
 *       For a CUMULATIVE delivery. A track that re-ships everything it has
 *       ever built, with a report covering only the newest wave, is not
 *       hiding anything , but without --since every unchanged file reads
 *       as undocumented and the real signal drowns. My own H4 report
 *       tripped this within a minute of the checker existing.
 *
 *   node scripts/verify-report.mjs --zip … --json
 *
 * EXIT  0 no disagreement found   1 disagreement   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const zip = arg("--zip");
const since = arg("--since");
const asJson = argv.includes("--json");

if (!zip) { console.error("usage: verify-report.mjs --zip <ordence-track-X.zip> [--json]"); process.exit(78); }
if (!fs.existsSync(zip)) { console.error("verify-report , no such zip: " + zip); process.exit(78); }
if (spawnSync("which", ["unzip"]).status !== 0) { console.error("verify-report , unzip is required"); process.exit(78); }

const run = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", ...o });

const listing = run("unzip", ["-Z1", zip]);
if (listing.status !== 0) { console.error("verify-report , cannot read the zip"); process.exit(78); }
const delivered = listing.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/"));

if (!delivered.includes("TRACK-REPORT.md")) {
  console.error("verify-report , the zip has no TRACK-REPORT.md. Nothing to verify against.");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-report-"));
run("unzip", ["-o", "-q", zip, "TRACK-REPORT.md", "-d", tmp]);
const report = fs.readFileSync(path.join(tmp, "TRACK-REPORT.md"), "utf8");
fs.rmSync(tmp, { recursive: true, force: true });

/**
 * Paths the report names. Only backticked ones: prose mentions a
 * directory or a concept constantly, and treating those as claims would
 * bury the real disagreements in noise. A checker nobody can read is a
 * checker nobody runs.
 */
const NAMED = new Set();
for (const m of report.matchAll(/`([^`\n]+)`/g)) {
  const t = m[1].trim();
  if (/^[\w./()[\]@-]+\.(ts|tsx|mts|mjs|js|sql|json|md|yml|yaml|css)$/.test(t)) NAMED.add(t.replace(/^\.\//, ""));
}

/**
 * With --since, only files that are NEW or CHANGED count as this wave's
 * work. Compared by content, not by name: a file present in both zips but
 * modified is this wave's, and a file merely carried forward is not.
 */
let considered = delivered;
if (since) {
  if (!fs.existsSync(since)) { console.error("verify-report , no such zip: " + since); process.exit(78); }
  const hashOf = (z) => {
    const out = new Map();
    const r = run("unzip", ["-v", z]);
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+([0-9a-f]{8})\s+(.+)$/.exec(line);
      if (m) out.set(m[2].trim(), m[1]);
    }
    return out;
  };
  const now = hashOf(zip), before = hashOf(since);
  considered = delivered.filter((p) => before.get(p) !== now.get(p));
}

const deliveredSet = new Set(delivered);
const isCode = (p) => /\.(ts|tsx|mts|mjs|js|sql|json|css)$/.test(p);

/** A report may reference a file it did not change , as context. Match on basename too. */
const deliveredBasenames = new Set(delivered.map((p) => p.split("/").pop()));

/**
 * ⚠️ A BARE FILENAME IS USUALLY PROSE, NOT A CLAIM. Reports name
 * `ghost.ts` while describing a test, or `CHANGELOG.md` while explaining
 * which files are shared. Treating those as claims buried four real
 * questions under four fake ones the first time this ran , against my own
 * report. Only a path with a directory in it is treated as a claim; bare
 * names are reported separately and quietly.
 */
const SHARED_BY_DEFINITION = new Set(["package.json", "CHANGELOG.md", "scripts/run-gates.mjs"]);
const notDelivered = [...NAMED].filter(
  (p) => !deliveredSet.has(p) && !deliveredBasenames.has(p.split("/").pop()) && !SHARED_BY_DEFINITION.has(p),
);
const claimedAbsent = notDelivered.filter((p) => p.includes("/"));
const mentionedOnly = notDelivered.filter((p) => !p.includes("/"));

const undocumented = considered.filter(
  (p) => p !== "TRACK-REPORT.md" && !p.startsWith("PATCH-REQUEST-") && isCode(p) &&
    !NAMED.has(p) && ![...NAMED].some((n) => n.split("/").pop() === p.split("/").pop()),
);

const sqlDelivered = considered.filter((p) => /^SQL-FILES\/\d{4}_/.test(p)).map((p) => p.slice(10, 14)).sort();
const sqlNamed = [...new Set([...report.matchAll(/\b(0[0-9]{3})\b/g)].map((m) => m[1]))].sort();
const sqlUnmentioned = sqlDelivered.filter((n) => !sqlNamed.includes(n));

/**
 * Evidence, crudely measured. Not "is this true" , only "did they show
 * their working at all". A report of assertions with no command, no
 * output and no number is the shape every one of the 23 known
 * built-and-unreachable defects shipped behind.
 */
const evidence = {
  codeBlocks: (report.match(/```/g) || []).length / 2,
  commands: (report.match(/\b(npm run|node scripts\/|npx |psql |SELECT )/g) || []).length,
  numbers: (report.match(/\b\d{1,6}\b/g) || []).length,
  refusalWords: (report.match(/\b(refus|fail|REFUS|would have|without it|removed|broke)/g) || []).length,
};
const thin = evidence.commands < 3 && evidence.codeBlocks < 1;
const noDisproof = evidence.refusalWords < 3;

const problems = [];
if (claimedAbsent.length) problems.push({ kind: "claimed-but-absent", items: claimedAbsent });
if (undocumented.length) problems.push({ kind: "delivered-but-undocumented", items: undocumented });
if (sqlUnmentioned.length) problems.push({ kind: "migration-not-explained", items: sqlUnmentioned });
if (thin) problems.push({ kind: "no-evidence", items: ["no commands and no output blocks in the report"] });
if (noDisproof) problems.push({ kind: "no-disproof", items: ["nothing describing what was tried and failed, or what would have differed"] });

if (asJson) {
  console.log(JSON.stringify({ zip: path.basename(zip), delivered: delivered.length, problems, evidence }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log(`verify-report , ${path.basename(zip)}`);
console.log(`  ${delivered.length} files delivered${since ? `, ${considered.length} new or changed since ${path.basename(since)}` : ""}, ${NAMED.size} named in the report`);
console.log(`  evidence: ${evidence.commands} command reference(s), ${evidence.codeBlocks} output block(s)`);
if (mentionedOnly.length) {
  console.log(`  ${mentionedOnly.length} bare filename(s) mentioned but not delivered, probably prose: ` +
    mentionedOnly.slice(0, 8).join(", "));
}
console.log("");

if (problems.length === 0) {
  console.log("No disagreement between the report and the zip.");
  console.log("");
  console.log("⚠️ THIS IS NOT ACCEPTANCE. It means the report describes the files that");
  console.log("   are present. Whether the claims are TRUE is still yours to disprove.");
  process.exit(0);
}

const LABEL = {
  "claimed-but-absent": "The report names these; the zip does not contain them",
  "delivered-but-undocumented": "The zip contains these; the report never mentions them",
  "migration-not-explained": "Migrations delivered but not discussed in the report",
  "no-evidence": "The report asserts without showing working",
  "no-disproof": "Nothing in the report describes a disproof attempt",
};

for (const p of problems) {
  console.log(`  ${LABEL[p.kind]}:`);
  for (const i of p.items.slice(0, 30)) console.log(`      ${i}`);
  if (p.items.length > 30) console.log(`      … and ${p.items.length - 30} more`);
  console.log("");
}

console.log("Read these before reading the report. Every one is a question with a");
console.log("short answer, and a report that cannot answer them quickly is a report");
console.log("that will not survive the harder questions either.");
process.exit(1);
