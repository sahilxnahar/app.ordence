#!/usr/bin/env node
/**
 * Ordence , ASSEMBLE A WAVE FROM SEVEN TRACK DELIVERIES
 * Version: v1.82.0-alpha - Infra wave H3 (integration, track H)
 *
 * WHY THIS IS NOT `rehearse-delivery.mjs` RUN SEVEN TIMES
 * ------------------------------------------------------
 * Rehearsal answers "is this ONE delivery safe". Assembly answers a
 * different question that no single rehearsal can: **do these seven
 * agree with each other.** Three failures only exist in the plural:
 *
 *   1. two tracks writing the same file. Ownership catches most of it,
 *      but a track may legitimately own a path another track also
 *      touched through a patch request.
 *   2. two tracks claiming the same migration number. Each is inside its
 *      own block and both look fine alone.
 *   3. a delivery that passes the gates alone and fails once another
 *      track's change is also present. This is the common one and it is
 *      invisible from inside any track.
 *
 * ⚠️ IT APPLIES THEM ONE AT A TIME AND RUNS THE GATES AFTER EACH. That
 * costs more wall clock than applying all seven and testing once, and it
 * buys the only thing that matters when something breaks: knowing WHICH
 * one broke it. Applying seven and getting a red result tells you almost
 * nothing.
 *
 * YOUR WORKING TREE IS NEVER TOUCHED. Everything happens in a scratch
 * copy, and nothing is deployed, pushed or committed.
 *
 * USAGE
 *   node scripts/assemble-wave.mjs --order A,B,C,D,E,F,G --dir ~/deliveries
 *   node scripts/assemble-wave.mjs --order A,B --dir ~/d --keep
 *
 * It expects `ordence-track-<L>.zip` in --dir. A letter with no zip is
 * reported as absent and skipped, not guessed at.
 *
 * EXIT  0 every delivery accepted   1 at least one refused   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };

const order = (arg("--order") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const dir = arg("--dir");
const keep = argv.includes("--keep");
/**
 * ⚠️ TEST ONLY, AND NAMED SO IT CANNOT BE MISTAKEN FOR AN OPTION.
 * The structural checks , ownership, collisions, nesting , are fast. The
 * gates are not, and running them for every case makes the test suite
 * take minutes and therefore stop being run, which is how gates die here.
 * One test still runs them for real.
 */
const skipGates = argv.includes("--DANGEROUSLY-skip-gates");

if (order.length === 0 || !dir) {
  console.error("usage: assemble-wave.mjs --order A,B,C --dir <folder of ordence-track-*.zip> [--keep]");
  process.exit(78);
}
for (const bin of ["unzip", "tar"]) {
  if (spawnSync("which", [bin]).status !== 0) {
    console.error(`assemble-wave , \`${bin}\` is required and not installed`);
    process.exit(78);
  }
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ordence-assemble-"));
const tree = path.join(scratch, "tree");
fs.mkdirSync(tree);

console.log("assemble-wave , scratch at " + scratch);
console.log("  copying the repo (your working tree is not touched)");
const cp = run("bash", ["-c",
  "cd " + JSON.stringify(REPO) + " && tar --exclude=./node_modules --exclude=./.next " +
  "--exclude=./.git --exclude=./tsconfig.tsbuildinfo -cf - . | tar -xf - -C " + JSON.stringify(tree)]);
if (cp.status !== 0) { console.error(cp.stderr); process.exit(78); }

/** Baseline. If the gates are red BEFORE any delivery, nothing after is interpretable. */
console.log("\n[baseline] gates on the untouched copy");
const base = skipGates ? { status: 0, stdout: "" } : run("node", ["scripts/run-gates.mjs", "static"], { cwd: tree });
if (base.status !== 0) {
  console.error("assemble-wave , the BASELINE is red. Fix the repo before assembling.");
  console.error(base.stdout.split("\n").slice(-25).join("\n"));
  process.exit(78);
}
console.log("  ok , baseline green");

const claimed = new Map();     // repo path -> track that wrote it
const migrations = new Map();  // "0131" -> track
const results = [];
const patchRequests = [];

for (const L of order) {
  const zip = path.join(dir, `ordence-track-${L}.zip`);
  console.log(`\n──── track ${L} ────`);

  if (!fs.existsSync(zip)) {
    console.log("  ABSENT , no ordence-track-" + L + ".zip in " + dir);
    results.push({ L, verdict: "absent" });
    continue;
  }

  const problems = [];

  // 1. Listing and ownership.
  const listing = run("unzip", ["-Z1", zip]);
  if (listing.status !== 0) {
    results.push({ L, verdict: "refused", problems: ["the zip cannot be read"] });
    continue;
  }
  const paths = listing.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/"));

  const tops = new Set(paths.map((p) => p.split("/")[0]));
  if (tops.size === 1 && !fs.existsSync(path.join(tree, [...tops][0]))) {
    problems.push(`every path is under "${[...tops][0]}/", which is not a repo directory. ` +
      "Built from inside a folder; it would extract one level too deep.");
  }

  const listFile = path.join(scratch, `list-${L}.txt`);
  fs.writeFileSync(listFile, listing.stdout);
  const own = run("node", [path.join(REPO, "scripts/check-track-ownership.mjs"),
    "--track", L, "--files", listFile]);
  if (own.status !== 0) {
    problems.push("ownership refused:\n" + own.stderr.split("\n").filter(Boolean).map((l) => "      " + l.trim()).join("\n"));
  }

  if (!paths.includes("TRACK-REPORT.md")) problems.push("no TRACK-REPORT.md");

  // 2. Cross-track collisions. THIS IS THE CHECK THAT ONLY EXISTS IN THE PLURAL.
  for (const p of paths) {
    if (p === "TRACK-REPORT.md" || p.startsWith("PATCH-REQUEST-")) continue;
    if (claimed.has(p)) problems.push(`collision: ${p} was already written by track ${claimed.get(p)}`);
    const m = /^SQL-FILES\/(\d{4})_/.exec(p);
    if (m) {
      if (migrations.has(m[1])) problems.push(`migration ${m[1]} already delivered by track ${migrations.get(m[1])}`);
      migrations.set(m[1], L);
    }
  }

  if (problems.length > 0) {
    console.log("  REFUSED");
    for (const p of problems) console.log("    x " + p);
    results.push({ L, verdict: "refused", problems });
    continue;   // NOT applied. A refused delivery must not touch the tree.
  }

  // 3. Apply, then gate. One at a time, so a failure names its cause.
  const ex = run("unzip", ["-o", "-q", zip, "-d", tree]);
  if (ex.status !== 0) {
    results.push({ L, verdict: "refused", problems: ["extract failed"] });
    continue;
  }
  for (const p of paths) if (!p.startsWith("PATCH-REQUEST-")) claimed.set(p, L);
  for (const p of paths) if (p.startsWith("PATCH-REQUEST-")) patchRequests.push({ L, file: p });

  const gates = skipGates ? { status: 0, stdout: "", stderr: "" } : run("node", ["scripts/run-gates.mjs", "static"], { cwd: tree });
  if (gates.status !== 0) {
    console.log("  REFUSED , gates went red WITH this delivery applied");
    /**
     * Name the gate, then show ITS section. Two earlier versions printed
     * either the summary line alone ("1 FAILED", which names nothing) or
     * whichever section happened to sit above the summary, which was the
     * last gate that PASSED. Read the summary for the failing id first.
     *
     * The marker in that summary is 🔴, not ❌. My second attempt guessed
     * the marker instead of reading the runner, matched nothing, and fell
     * through to printing twenty lines of passing gates. Three attempts
     * to print an error message, which is a fair illustration of why the
     * rule here is to check the output rather than assume it.
     */
    const lines = gates.stdout.split("\n");
    const failing = lines
      .filter((l) => /^\s*(🔴|❌|✗)\s+check:/.test(l))
      .map((l) => (l.match(/check:([a-z0-9-]+)/) || [])[1])
      .filter(Boolean);
    if (failing.length === 0) {
      console.log(lines.slice(-20).map((l) => "    " + l).join("\n"));
    }
    for (const id of failing) {
      const at = lines.findIndex((l) => l.includes(`──── check:${id} ────`));
      console.log(`    gate that went red: check:${id}`);
      if (at >= 0) console.log(lines.slice(at, at + 8).map((l) => "    " + l).join("\n"));
    }
    /** The detail lands on stderr; without this the reader gets a name and no reason. */
    const err = gates.stderr.split("\n").filter(Boolean);
    if (err.length) console.log(err.slice(0, 14).map((l) => "    " + l).join("\n"));
    const rest = order.filter((x) => x !== L);
    console.log(`\n  The scratch tree now carries track ${L} and is not usable. Nothing was`);
    console.log("  unwound: a partial unwind produces a state no zip describes, which is");
    console.log("  the failure that cost three days of recovery. Start again without it:");
    console.log(rest.length
      ? `    npm run assemble -- --order ${rest.join(",")} --dir <dir>`
      : "    (that was the only track in this run; fix it and re-run)");
    results.push({ L, verdict: "refused", problems: ["gates red once applied, see above"] });
    /**
     * ⚠️ THE TREE NOW CARRIES A BAD DELIVERY. Stopping here rather than
     * unwinding is deliberate: a partial unwind produces a state no zip
     * describes, which is precisely the failure mode that cost three days
     * of recovery. Re-run without this letter in --order.
     */
    break;
  }

  const sql = paths.filter((p) => /^SQL-FILES\/\d{4}_/.test(p)).map((p) => p.slice(10, 14));
  console.log(`  ACCEPTED , ${paths.length} files${sql.length ? ", migrations " + sql.join(", ") : ", no migrations"}`);
  results.push({ L, verdict: "accepted", files: paths.length, sql });
}

// ── Summary ──────────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════");
const accepted = results.filter((r) => r.verdict === "accepted");
const refused = results.filter((r) => r.verdict === "refused");
const absent = results.filter((r) => r.verdict === "absent");

for (const r of results) {
  const tag = { accepted: "ACCEPTED", refused: "REFUSED ", absent: "ABSENT  " }[r.verdict];
  console.log(`  ${tag}  track ${r.L}${r.verdict === "accepted" ? `  ${r.files} files` : ""}`);
}
console.log(`\n  ${accepted.length} accepted, ${refused.length} refused, ${absent.length} absent`);

const allSql = accepted.flatMap((r) => r.sql).sort();
console.log(`  migrations to run, oldest first: ${allSql.length ? allSql.join(", ") : "none"}`);

if (patchRequests.length) {
  console.log("\n  patch requests, to be applied by hand at integration:");
  for (const p of patchRequests) console.log(`    - ${p.file} (track ${p.L})`);
}

console.log(keep ? `\n  assembled tree kept at ${tree}` : "");
if (!keep) fs.rmSync(scratch, { recursive: true, force: true });

console.log("\nNothing was deployed, pushed or committed.");
process.exit(refused.length > 0 ? 1 : 0);
