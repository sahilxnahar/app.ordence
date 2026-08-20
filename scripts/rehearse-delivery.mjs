#!/usr/bin/env node
/**
 * Ordence , REHEARSE A TRACK DELIVERY BEFORE IT TOUCHES THE REPO
 * Version: v1.82.0-alpha - Infra wave 14 (integration, track H)
 *
 * WHY THIS EXISTS
 * ---------------
 * Assembly has now failed three times, each differently:
 *
 *   1. An archive extracted into `components/` instead of the repo root.
 *      213 real files were deleted, 305 imports went unresolved, and
 *      webpack reported five of them because it stops early.
 *   2. A patch shipped where a full tree was needed.
 *   3. A root layout missing from the tree, so `next build` died on the
 *      first page it reached and named only that page.
 *
 * Every one was found AFTER the push. Each was cheap to detect and
 * expensive to discover. This makes detection a command.
 *
 * WHAT IT DOES
 * ------------
 *   1. Copies the pristine repo to a scratch directory. YOUR WORKING
 *      TREE IS NEVER TOUCHED. That is the point: a rehearsal that can
 *      damage the thing it rehearses is not a rehearsal.
 *   2. Reads the zip listing and runs the ownership gate against it.
 *   3. Extracts the zip over the scratch copy.
 *   4. Asserts the tree still has its spine: a root layout, middleware,
 *      package.json. This is failure 3, made impossible.
 *   5. Runs the static gates on the ASSEMBLED tree, not the track's.
 *   6. Prints what changed and what it would cost.
 *
 * USAGE
 *   node scripts/rehearse-delivery.mjs --track A --zip ~/ordence-track-A.zip
 *   node scripts/rehearse-delivery.mjs --track A --zip … --keep
 *
 * EXIT  0 the delivery is safe to assemble   1 it is not   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const letter = (arg("--track") || "").toUpperCase();
const zip = arg("--zip");
const keep = argv.includes("--keep");

if (!letter || !zip) {
  console.error("usage: rehearse-delivery.mjs --track <A-G> --zip <path> [--keep]");
  process.exit(78);
}
if (!fs.existsSync(zip)) {
  console.error("rehearse , no such zip: " + zip);
  process.exit(78);
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });

const need = (bin) => {
  if (run("which", [bin]).status !== 0) {
    console.error("rehearse , `" + bin + "` is required and not installed");
    process.exit(78);
  }
};
need("unzip");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ordence-rehearse-"));
const tree = path.join(scratch, "tree");
let failed = false;
const step = (n, s) => console.log("\n[" + n + "] " + s);
const bad = (m) => { failed = true; console.error("  FAIL " + m); };
const ok = (m) => console.log("  ok   " + m);

try {
  // ── 1. Pristine copy ───────────────────────────────────────────────
  step(1, "copying the repo to scratch (your tree is not touched)");
  fs.mkdirSync(tree);
  const cp = run("bash", ["-c",
    "cd " + JSON.stringify(REPO) + " && tar --exclude=./node_modules --exclude=./.next " +
    "--exclude=./.git --exclude=./tsconfig.tsbuildinfo -cf - . | tar -xf - -C " + JSON.stringify(tree)]);
  if (cp.status !== 0) { bad("copy failed: " + cp.stderr); throw new Error("copy"); }
  ok("scratch tree at " + tree);

  // ── 2. Ownership, from the listing alone ───────────────────────────
  step(2, "ownership , what does this zip claim to write");
  const listing = run("unzip", ["-Z1", zip]);
  if (listing.status !== 0) { bad("cannot read the zip"); throw new Error("zip"); }
  const listFile = path.join(scratch, "listing.txt");
  fs.writeFileSync(listFile, listing.stdout);

  /**
   * A NESTED ROOT IS FAILURE 1. If every path shares one leading
   * directory that is not a real repo directory, the zip was made from
   * inside a folder and will extract one level too deep.
   */
  const paths = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const tops = new Set(paths.map((p) => p.split("/")[0]));
  if (tops.size === 1) {
    const only = [...tops][0];
    if (!fs.existsSync(path.join(tree, only))) {
      bad("every path is under \"" + only + "/\", which is not a repo directory. " +
          "This zip was built from inside a folder and would extract one level too deep.");
    }
  }

  const own = run("node", [path.join(REPO, "scripts/check-track-ownership.mjs"),
    "--track", letter, "--files", listFile], { stdio: "inherit" });
  if (own.status !== 0) bad("ownership check refused this delivery"); else ok("all files inside the track's block");

  if (!paths.some((p) => p === "TRACK-REPORT.md")) bad("no TRACK-REPORT.md in the zip");
  else ok("TRACK-REPORT.md present");

  // ── 3. Apply ───────────────────────────────────────────────────────
  step(3, "extracting over the scratch tree");
  const ex = run("unzip", ["-o", "-q", zip, "-d", tree]);
  if (ex.status !== 0) { bad("extract failed"); throw new Error("extract"); }
  ok("extracted " + paths.length + " entries");

  // ── 4. The spine ───────────────────────────────────────────────────
  step(4, "spine , the files whose absence kills the build");
  for (const f of ["package.json", "middleware.ts", "app/layout.tsx", "app/page.tsx", "next.config.ts"]) {
    if (fs.existsSync(path.join(tree, f))) ok(f);
    else if (f === "next.config.ts" && fs.existsSync(path.join(tree, "next.config.mjs"))) ok("next.config.mjs");
    else bad("missing after extract: " + f);
  }

  // ── 5. Gates, on the assembled tree ────────────────────────────────
  step(5, "static gates on the ASSEMBLED tree");
  const gates = run("node", ["scripts/run-gates.mjs", "static"], { cwd: tree, stdio: "inherit" });
  if (gates.status !== 0) bad("static gates failed on the assembled tree"); else ok("all static gates pass");

  // ── 6. Size of the change ──────────────────────────────────────────
  step(6, "what this delivery costs");
  const sql = paths.filter((p) => /^SQL-FILES\/\d{4}_/.test(p));
  console.log("  files       : " + paths.filter((p) => !p.endsWith("/")).length);
  console.log("  migrations  : " + (sql.length ? sql.map((s) => s.slice(10, 14)).join(", ") : "none"));
} catch {
  /* the step that failed already said so */
} finally {
  if (keep) console.log("\nscratch kept at " + scratch);
  else fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failed) {
  console.error("REFUSED , do not assemble track " + letter + " until the above is fixed.");
  process.exit(1);
}
console.log("ACCEPTED , track " + letter + " is safe to assemble.");
