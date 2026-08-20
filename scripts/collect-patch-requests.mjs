#!/usr/bin/env node
/**
 * Ordence , COLLECT EVERY PATCH REQUEST INTO ONE CHECKLIST
 * Version: v1.82.0-alpha - Infra wave H5 (integration, track H)
 *
 * WHY THIS DOES NOT APPLY THEM
 * ----------------------------
 * I set out to write an applier. A patch request is prose: a track
 * describes, in words, a change it needs in `package.json`,
 * `CHANGELOG.md` or `scripts/run-gates.mjs`, because those three files
 * are shared and no track may edit them.
 *
 * Prose cannot be applied mechanically without inventing a structure the
 * tracks were never told to use, and a tool that GUESSES at an edit to
 * `package.json` is a tool that will one day guess wrong about a
 * dependency or a script name, silently, in a file every other track
 * depends on. So this collects, orders and checks. A human applies.
 *
 * That is a smaller tool than I intended and it is the right size. The
 * manual step that remains is one person editing three files with a
 * checklist in front of them, which is a very different risk from seven
 * automated edits nobody reviewed.
 *
 * WHAT IT DOES
 *   1. Pulls every PATCH-REQUEST-*.md out of every track zip.
 *   2. Writes ONE file, in the order the tracks will be assembled.
 *   3. Flags requests that touch the same file, because two tracks both
 *      wanting a change in `package.json` is where a hand edit loses one
 *      of them.
 *   4. After you have applied them, `--check` re-reads the repo and says
 *      which requested strings are now present and which are not.
 *
 * USAGE
 *   node scripts/collect-patch-requests.mjs --order A,B,C --dir <folder>
 *   node scripts/collect-patch-requests.mjs --order A,B,C --dir <folder> --check
 *
 * EXIT  0 nothing outstanding   1 something to do   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };

const order = (arg("--order") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const dir = arg("--dir");
const check = argv.includes("--check");
const OUT = path.join(ROOT, "..", "PATCH-REQUESTS.md");

if (!order.length || !dir) {
  console.error("usage: collect-patch-requests.mjs --order A,B,C --dir <folder> [--check]");
  process.exit(78);
}
if (spawnSync("which", ["unzip"]).status !== 0) { console.error("collect , unzip is required"); process.exit(78); }

const run = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", ...o });
const SHARED = ["package.json", "CHANGELOG.md", "scripts/run-gates.mjs"];

const found = [];
for (const L of order) {
  const zip = path.join(dir, `ordence-track-${L}.zip`);
  if (!fs.existsSync(zip)) continue;
  const listing = run("unzip", ["-Z1", zip]).stdout.split("\n").map((s) => s.trim());
  const names = listing.filter((p) => /^PATCH-REQUEST-[A-Z]\.md$/.test(p));
  if (!names.length) continue;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patchreq-"));
  for (const n of names) {
    run("unzip", ["-o", "-q", zip, n, "-d", tmp]);
    const text = fs.readFileSync(path.join(tmp, n), "utf8");
    /** Which shared file does it talk about? Named, so collisions are visible. */
    const touches = SHARED.filter((f) => text.includes(f));
    found.push({ track: L, file: n, text, touches });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (found.length === 0) {
  console.log(`collect , no patch requests in ${order.join(", ")}. Nothing to apply.`);
  process.exit(0);
}

// ── --check: did the work get done? ──────────────────────────────────
if (check) {
  console.log("collect --check , what is still outstanding\n");
  let outstanding = 0;
  for (const r of found) {
    /**
     * Quoted strings in the request are the only machine-checkable part.
     * A request that quotes nothing cannot be checked, and this says so
     * rather than reporting it as done , which would be the same
     * verified-by-a-floor mistake as everything else in this repo.
     */
    const quoted = [...r.text.matchAll(/`([^`\n]{3,80})`/g)].map((m) => m[1])
      .filter((q) => !SHARED.includes(q) && !/^[A-Z-]+\.md$/.test(q));
    if (quoted.length === 0) {
      console.log(`  ?  track ${r.track} , quotes nothing checkable. Read it by hand.`);
      outstanding++;
      continue;
    }
    const missing = quoted.filter((q) => {
      for (const f of SHARED) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(q)) return false;
      }
      return true;
    });
    if (missing.length === 0) {
      console.log(`  ok track ${r.track} , every quoted string is present in a shared file`);
    } else {
      outstanding++;
      console.log(`  x  track ${r.track} , not found in any shared file:`);
      for (const q of missing.slice(0, 8)) console.log(`       ${q}`);
    }
  }
  console.log("");
  console.log(outstanding === 0
    ? "Nothing outstanding. Note this only checks strings the requests QUOTED."
    : `${outstanding} request(s) still to apply or to read by hand.`);
  process.exit(outstanding === 0 ? 0 : 1);
}

// ── Write the checklist ──────────────────────────────────────────────
const collisions = new Map();
for (const r of found) for (const t of r.touches) {
  if (!collisions.has(t)) collisions.set(t, []);
  collisions.get(t).push(r.track);
}
const contested = [...collisions].filter(([, tracks]) => tracks.length > 1);

let md = `# Patch requests, in assembly order\n\n`;
md += `Generated from ${found.length} request(s) across tracks ${order.join(", ")}.\n\n`;
md += `These are changes to the three shared files that no track may edit:\n`;
md += SHARED.map((f) => `\`${f}\``).join(", ") + `.\n\n`;
md += `**Apply them by hand, in this order.** Nothing here is applied\n`;
md += `automatically: prose cannot be turned into an edit to \`package.json\`\n`;
md += `without guessing, and a wrong guess in a shared file is silent.\n\n`;

if (contested.length) {
  md += `## Read this first, ${contested.length} contested file(s)\n\n`;
  for (const [file, tracks] of contested) {
    md += `- \`${file}\` , requested by tracks ${tracks.join(" and ")}. `;
    md += `Apply both, then re-read. A hand edit is where one of two changes to one file gets lost.\n`;
  }
  md += `\n`;
}

for (const r of found) {
  md += `---\n\n## Track ${r.track}\n\n`;
  md += r.touches.length ? `Touches: ${r.touches.map((t) => "`" + t + "`").join(", ")}\n\n` : `Touches: not stated\n\n`;
  md += r.text.trim() + `\n\n`;
}

md += `---\n\n## When you have applied them\n\n`;
md += `\`\`\`\nnode scripts/collect-patch-requests.mjs --order ${order.join(",")} --dir <dir> --check\n\`\`\`\n\n`;
md += `That re-reads the shared files and reports which requested strings are\n`;
md += `present. It can only check what a request QUOTED; anything described\n`;
md += `in prose alone still needs a human.\n`;

fs.writeFileSync(OUT, md);
console.log(`collect , ${found.length} patch request(s) -> ${path.resolve(OUT)}`);
if (contested.length) {
  console.log(`\n  ${contested.length} contested file(s), read these first:`);
  for (const [file, tracks] of contested) console.log(`    ${file} , tracks ${tracks.join(", ")}`);
}
console.log("\nApply by hand, then re-run with --check.");
process.exit(1);
